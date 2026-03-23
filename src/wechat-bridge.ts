import { startWeixinLoginWithQr, waitForWeixinLogin } from "./login-qr.js";
import { extractText, getUpdates, sendTextMessage, type WeixinMessage } from "./weixin-api.js";
import type {
  LoginQrStartParams,
  LoginQrWaitParams,
  OnMessageParams,
  WechatOpenClawBridgeConfig,
} from "./protocol.js";
import type { StdioTransport } from "./stdio.js";

interface BridgeState {
  getUpdatesBuf: string;
  longPollTimeoutMs: number;
}

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

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
  private contextTokens = new Map<string, string>();

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
    });
    return result as Record<string, unknown>;
  }

  async loginQrWait(params: LoginQrWaitParams): Promise<Record<string, unknown>> {
    const result = await waitForWeixinLogin({
      sessionKey: params.sessionKey,
      apiBaseUrl: params.baseUrl || this.config.base_url,
      timeoutMs: params.timeoutMs,
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
    const contextToken = this.contextTokens.get(to);
    await sendTextMessage({
      baseUrl: this.config.base_url,
      token: this.config.bot_token,
      to,
      text: params.text,
      contextToken,
    });
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
    const fromUserId = message.from_user_id;
    if (!fromUserId) return;

    const text = extractText(message);
    if (!text) return;

    if (message.context_token) {
      this.contextTokens.set(fromUserId, message.context_token);
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
  }

  private extractPeerId(channelId: string): string {
    const separator = channelId.indexOf(":");
    return separator >= 0 ? channelId.slice(separator + 1) : channelId;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
