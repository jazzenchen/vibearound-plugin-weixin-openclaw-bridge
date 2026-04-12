/**
 * WeChat stream renderer — extends BlockRenderer for WeChat OpenClaw Bridge.
 *
 * WeChat is send-only (no message editing). Uses streaming=false so each
 * block is held until complete, then sent as one message.
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { WechatOpenClawBridge } from "./wechat-bridge.js";

type LogFn = (level: string, message: string) => void;

export class AgentStreamHandler extends BlockRenderer<string> {
  private bridge: WechatOpenClawBridge;
  private log: LogFn;

  constructor(bridge: WechatOpenClawBridge, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: false,
      flushIntervalMs: 500,
      verbose,
    });
    this.bridge = bridge;
    this.log = log;
  }

  protected async sendText(chatId: string, text: string): Promise<void> {
    await this.bridge.sendSystemText({ chatId, text });
  }

  protected async sendBlock(chatId: string, _kind: BlockKind, content: string): Promise<string | null> {
    try {
      await this.bridge.sendSystemText({ chatId, text: content });
    } catch (e) {
      this.log("error", `sendBlock failed: ${e}`);
    }
    return "sent"; // non-null sentinel — prevents duplicate sends
  }

  // No editBlock — WeChat doesn't support message editing
}
