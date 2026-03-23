import path from "node:path";
import os from "node:os";

import { getConfig, getUpdates, sendTyping } from "./api/api.js";
import type { WeixinApiOptions } from "./api/api.js";
import type { WeixinMessage } from "./api/types.js";
import { TypingStatus } from "./api/types.js";
import { extractInboundText, getContextToken, setContextToken, shouldHandleInboundMessage } from "./messaging/inbound.js";
import { sendMessageWeixin } from "./messaging/send.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { downloadRemoteImageToTemp, type UploadedFileInfo, uploadFileAttachmentToWeixin, uploadFileToWeixin, uploadVideoToWeixin } from "./cdn/upload.js";
import { getMimeFromFilename } from "./media/mime.js";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "./auth/login-qr.js";
import type {
  LoginQrStartParams,
  LoginQrWaitParams,
  OnMessageParams,
  WechatOpenClawBridgeConfig,
} from "./protocol.js";
import type { StdioTransport } from "./stdio.js";
import { logger } from "./util/logger.js";

interface BridgeState {
  getUpdatesBuf: string;
  longPollTimeoutMs: number;
}

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MEDIA_OUTBOUND_TEMP_DIR = path.join(os.tmpdir(), "vibearound", "weixin", "media", "outbound-temp");

type LogFn = (level: string, message: string) => void;

export class WechatOpenClawBridge {
  private config: WechatOpenClawBridgeConfig;
  private transport: StdioTransport;
  private log: LogFn;
  private state: BridgeState = {
    getUpdatesBuf: "",
    longPollTimeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
  };
  private polling = false;
  private stopped = false;
  private typingTicketByPeer = new Map<string, string>();

  constructor(config: WechatOpenClawBridgeConfig, transport: StdioTransport, log: LogFn) {
    this.config = config;
    this.transport = transport;
    this.log = log;
  }

  async probe(): Promise<{ id?: string; name: string }> {
    return {
      id: this.config.account_id,
      name: this.config.account_id || "WeChat OpenClaw Bridge",
    };
  }

  start(): void {
    if (this.polling || !this.config.bot_token) return;
    this.polling = true;
    this.stopped = false;
    void this.pollLoop();
  }

  stop(): void {
    this.stopped = true;
    this.polling = false;
  }

  async loginQrStart(params: LoginQrStartParams): Promise<Record<string, unknown>> {
    const result = await startWeixinLoginWithQr({
      accountId: params.accountId || this.config.account_id,
      apiBaseUrl: params.baseUrl || this.config.base_url,
      force: params.force,
      verbose: params.verbose,
    });
    return result as Record<string, unknown>;
  }

  async loginQrWait(params: LoginQrWaitParams): Promise<Record<string, unknown>> {
    const result = await waitForWeixinLogin({
      sessionKey: params.sessionKey,
      apiBaseUrl: params.baseUrl || this.config.base_url,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    if (result.connected && result.botToken) {
      this.config.bot_token = result.botToken;
      this.config.account_id = result.accountId;
      this.log("info", `QR login confirmed for account=${result.accountId}`);
      this.start();
    }
    return result as Record<string, unknown>;
  }

  async sendSystemText(params: { channelId: string; text: string; replyTo?: string }): Promise<void> {
    if (!this.config.bot_token) {
      throw new Error("bot_token is required before sending WeChat messages");
    }
    const to = this.extractPeerId(params.channelId);
    await sendMessageWeixin({
      to,
      text: params.text,
      opts: {
        baseUrl: this.config.base_url,
        token: this.config.bot_token,
        contextToken: getContextToken(this.config.account_id || "default", to),
      },
    });
  }

  async startTyping(channelId: string): Promise<void> {
    if (!this.config.bot_token) return;
    const to = this.extractPeerId(channelId);
    const ticket = await this.resolveTypingTicket(to);
    if (!ticket) return;
    await sendTyping({
      baseUrl: this.config.base_url,
      token: this.config.bot_token,
      body: {
        ilink_user_id: to,
        typing_ticket: ticket,
        status: TypingStatus.TYPING,
      },
    });
  }

  async stopTyping(channelId: string): Promise<void> {
    if (!this.config.bot_token) return;
    const to = this.extractPeerId(channelId);
    const ticket = this.typingTicketByPeer.get(to) ?? (await this.resolveTypingTicket(to));
    if (!ticket) return;
    await sendTyping({
      baseUrl: this.config.base_url,
      token: this.config.bot_token,
      body: {
        ilink_user_id: to,
        typing_ticket: ticket,
        status: TypingStatus.CANCEL,
      },
    });
  }

  async prepareMediaFromFile(filePath: string, to: string): Promise<UploadedFileInfo> {
    if (!this.config.bot_token) {
      throw new Error("bot_token is required before uploading WeChat media");
    }
    const uploadOpts: WeixinApiOptions = { baseUrl: this.config.base_url, token: this.config.bot_token };
    const mime = getMimeFromFilename(filePath);
    if (mime.startsWith("video/")) {
      return uploadVideoToWeixin({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl: DEFAULT_CDN_BASE_URL });
    }
    if (mime.startsWith("image/")) {
      return uploadFileToWeixin({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl: DEFAULT_CDN_BASE_URL });
    }
    return uploadFileAttachmentToWeixin({
      filePath,
      fileName: path.basename(filePath),
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl: DEFAULT_CDN_BASE_URL,
    });
  }

  async prepareMediaFromUrl(url: string, to: string): Promise<UploadedFileInfo> {
    const filePath = await downloadRemoteImageToTemp(url, MEDIA_OUTBOUND_TEMP_DIR);
    return this.prepareMediaFromFile(filePath, to);
  }

  async sendMediaFile(params: { channelId: string; filePath: string; text?: string }): Promise<void> {
    if (!this.config.bot_token) {
      throw new Error("bot_token is required before sending WeChat media");
    }
    const to = this.extractPeerId(params.channelId);
    await sendWeixinMediaFile({
      filePath: params.filePath,
      to,
      text: params.text ?? "",
      opts: {
        baseUrl: this.config.base_url,
        token: this.config.bot_token,
        contextToken: getContextToken(this.config.account_id || "default", to),
      },
      cdnBaseUrl: DEFAULT_CDN_BASE_URL,
    });
  }

  private async resolveTypingTicket(to: string): Promise<string | undefined> {
    const existing = this.typingTicketByPeer.get(to);
    if (existing) return existing;
    if (!this.config.bot_token) return undefined;
    try {
      const config = await getConfig({
        baseUrl: this.config.base_url,
        token: this.config.bot_token,
        ilinkUserId: to,
        contextToken: getContextToken(this.config.account_id || "default", to),
      });
      if (config.typing_ticket) {
        this.typingTicketByPeer.set(to, config.typing_ticket);
      }
      return config.typing_ticket;
    } catch (error) {
      logger.warn(`resolveTypingTicket failed for ${to}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped && this.config.bot_token) {
      try {
        const response = await getUpdates({
          baseUrl: this.config.base_url,
          token: this.config.bot_token,
          timeoutMs: this.state.longPollTimeoutMs,
          get_updates_buf: this.state.getUpdatesBuf,
        });

        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          this.state.longPollTimeoutMs = response.longpolling_timeout_ms;
        }
        if (response.get_updates_buf) {
          this.state.getUpdatesBuf = response.get_updates_buf;
        }

        if ((response.ret && response.ret !== 0) || (response.errcode && response.errcode !== 0)) {
          this.log(
            "warn",
            `getUpdates returned ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`,
          );
          await this.sleep(2000);
          continue;
        }

        for (const message of response.msgs ?? []) {
          this.handleInboundMessage(message);
        }
      } catch (error) {
        this.log("error", `getUpdates failed: ${error instanceof Error ? error.message : String(error)}`);
        await this.sleep(2000);
      }
    }
  }

  private handleInboundMessage(message: WeixinMessage): void {
    if (!shouldHandleInboundMessage(message)) return;

    const fromUserId = message.from_user_id;
    if (!fromUserId) return;

    const text = extractInboundText(message);
    if (message.context_token) {
      setContextToken(this.config.account_id || "default", fromUserId, message.context_token);
    }

    if (!text) {
      logger.debug(
        `drop inbound message_id=${String(message.message_id ?? "")} from=${fromUserId} because no text payload was extracted`,
      );
      return;
    }

    const params: OnMessageParams = {
      channelId: `weixin-openclaw-bridge:${fromUserId}`,
      messageId: String(message.message_id ?? `${Date.now()}`),
      chatType: "private",
      sender: {
        id: fromUserId,
        name: fromUserId,
        type: "user",
      },
      text,
    };

    this.transport.notify("on_message", params as unknown as Record<string, unknown>);
    this.log("debug", `on_message peer=${fromUserId} text=${text.slice(0, 80)}`);
  }

  private extractPeerId(channelId: string): string {
    const separator = channelId.indexOf(":");
    return separator >= 0 ? channelId.slice(separator + 1) : channelId;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
