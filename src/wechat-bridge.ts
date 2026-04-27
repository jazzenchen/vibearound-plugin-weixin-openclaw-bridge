import path from "node:path";
import os from "node:os";

import { getConfig, getUpdates, sendTyping } from "./api/api.js";
import type { WeixinApiOptions } from "./api/api.js";
import type { WeixinMessage } from "./api/types.js";
import { MessageItemType, TypingStatus } from "./api/types.js";
import { extractInboundText, getContextToken, isMediaItem, setContextToken, shouldHandleInboundMessage } from "./messaging/inbound.js";
import { sendMessageWeixin } from "./messaging/send.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { downloadRemoteImageToTemp, type UploadedFileInfo, uploadFileAttachmentToWeixin, uploadFileToWeixin, uploadVideoToWeixin } from "./cdn/upload.js";
import { getMimeFromFilename } from "./media/mime.js";
import { downloadMediaItem } from "./media/media-download.js";
import type { DownloadedMedia } from "./media/media-download.js";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "./auth/login-qr.js";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import type {
  LoginQrStartParams,
  LoginQrWaitParams,
  WechatOpenClawBridgeConfig,
} from "./protocol.js";
import { WECHAT_BASE_URL } from "./protocol.js";
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
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private streamHandler: import("./agent-stream.js").AgentStreamHandler | null = null;
  private state: BridgeState = {
    getUpdatesBuf: "",
    longPollTimeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
  };
  private polling = false;
  private stopped = false;
  private typingTicketByPeer = new Map<string, string>();

  constructor(config: WechatOpenClawBridgeConfig, agent: Agent, log: LogFn, cacheDir: string) {
    this.config = config;
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;
  }

  setStreamHandler(handler: import("./agent-stream.js").AgentStreamHandler): void {
    this.streamHandler = handler;
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
      apiBaseUrl: WECHAT_BASE_URL,
      force: params.force,
      verbose: params.verbose,
    });
    return result as Record<string, unknown>;
  }

  async loginQrWait(params: LoginQrWaitParams): Promise<Record<string, unknown>> {
    const result = await waitForWeixinLogin({
      sessionKey: params.sessionKey,
      apiBaseUrl: WECHAT_BASE_URL,
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

  async sendSystemText(params: { chatId: string; text: string; replyTo?: string }): Promise<void> {
    if (!this.config.bot_token) {
      throw new Error("bot_token is required before sending WeChat messages");
    }
    const to = this.extractPeerId(params.chatId);
    await sendMessageWeixin({
      to,
      text: params.text,
      opts: {
        baseUrl: WECHAT_BASE_URL,
        token: this.config.bot_token,
        contextToken: getContextToken(this.config.account_id || "default", to),
      },
    });
  }

  async startTyping(chatId: string): Promise<void> {
    if (!this.config.bot_token) return;
    const to = this.extractPeerId(chatId);
    const ticket = await this.resolveTypingTicket(to);
    if (!ticket) return;
    await sendTyping({
      baseUrl: WECHAT_BASE_URL,
      token: this.config.bot_token,
      body: {
        ilink_user_id: to,
        typing_ticket: ticket,
        status: TypingStatus.TYPING,
      },
    });
  }

  async stopTyping(chatId: string): Promise<void> {
    if (!this.config.bot_token) return;
    const to = this.extractPeerId(chatId);
    const ticket = this.typingTicketByPeer.get(to) ?? (await this.resolveTypingTicket(to));
    if (!ticket) return;
    await sendTyping({
      baseUrl: WECHAT_BASE_URL,
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
    const uploadOpts: WeixinApiOptions = { baseUrl: WECHAT_BASE_URL, token: this.config.bot_token };
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

  async sendMediaFile(params: { chatId: string; filePath: string; text?: string }): Promise<void> {
    if (!this.config.bot_token) {
      throw new Error("bot_token is required before sending WeChat media");
    }
    const to = this.extractPeerId(params.chatId);
    await sendWeixinMediaFile({
      filePath: params.filePath,
      to,
      text: params.text ?? "",
      opts: {
        baseUrl: WECHAT_BASE_URL,
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
        baseUrl: WECHAT_BASE_URL,
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
          baseUrl: WECHAT_BASE_URL,
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
          await this.sleep(2000);
          continue;
        }

        for (const message of response.msgs ?? []) {
          this.handleInboundMessage(message);
        }
      } catch (error) {
        await this.sleep(2000);
      }
    }
  }

  private async handleInboundMessage(message: WeixinMessage): Promise<void> {
    if (!shouldHandleInboundMessage(message)) return;

    const fromUserId = message.from_user_id;
    if (!fromUserId) return;

    const text = extractInboundText(message);
    if (message.context_token) {
      setContextToken(this.config.account_id || "default", fromUserId, message.context_token);
    }

    // Download media items (image, file, video)
    const messageId = String(message.message_id ?? Date.now());
    const downloadedMedia: DownloadedMedia[] = [];
    for (const item of message.item_list ?? []) {
      if (!isMediaItem(item)) continue;
      const media = await downloadMediaItem({
        item,
        cdnBaseUrl: DEFAULT_CDN_BASE_URL,
        cacheDir: this.cacheDir,
        channelKind: "weixin-openclaw-bridge",
        chatId: fromUserId,
        messageId: item.msg_id ?? messageId,
        label: `inbound[${fromUserId}]`,
      });
      if (media) downloadedMedia.push(media);
    }

    // Drop only if both text and media are empty
    if (!text && downloadedMedia.length === 0) {
      logger.debug(
        `drop inbound message_id=${messageId} from=${fromUserId} because no text or media payload`,
      );
      return;
    }

    // Build ACP prompt content blocks
    const contentBlocks: ContentBlock[] = [];

    if (text) {
      contentBlocks.push({ type: "text", text });
    } else if (downloadedMedia.length > 0) {
      // Media-only message — add descriptive text
      const types = [...new Set(downloadedMedia.map((m) => m.type))].join(", ");
      contentBlocks.push({ type: "text", text: `The user sent ${types}.` });
    }

    for (const media of downloadedMedia) {
      contentBlocks.push({
        type: "resource_link",
        uri: `file://${media.path}`,
        name: media.fileName ?? path.basename(media.path),
        mimeType: media.mimeType,
      });
    }

    if (contentBlocks.length === 0) return;

    const chatId = fromUserId;
    if (text && this.streamHandler?.consumePendingText(chatId, text)) {
      return;
    }

    // Notify stream handler and start typing BEFORE prompt
    this.streamHandler?.onPromptSent(chatId);
    await this.startTyping(chatId).catch((e) => {
      this.log("warn", `start typing failed: ${e}`);
    });

    // Send as ACP prompt — blocks until turn completes, returns real StopReason.
    // Session notifications stream in during the call.
    this.log("debug", `prompt peer=${fromUserId} blocks=${contentBlocks.length} text=${(text ?? "").slice(0, 80)}`);
    try {
      const response = await this.agent.prompt({
        sessionId: fromUserId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done peer=${fromUserId} stopReason=${response.stopReason}`);
      this.streamHandler?.onTurnEnd(chatId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log("error", `prompt failed peer=${fromUserId}: ${msg}`);
      this.streamHandler?.onTurnError(chatId, msg);
    } finally {
      await this.stopTyping(chatId).catch((e) => {
        this.log("warn", `stop typing failed: ${e}`);
      });
    }
  }

  private extractPeerId(chatId: string): string {
    const separator = chatId.indexOf(":");
    return separator >= 0 ? chatId.slice(separator + 1) : chatId;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
