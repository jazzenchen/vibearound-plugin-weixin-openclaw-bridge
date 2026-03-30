/**
 * AgentStreamHandler — receives ACP session updates and renders them as
 * separate WeChat messages, one per contiguous variant block.
 *
 * Extends BlockRenderer from @vibearound/plugin-channel-sdk which handles:
 *   - Block accumulation and kind-change detection
 *   - Verbose filtering (thinking / tool blocks)
 *
 * WeChat is send-only (no message editing), so no editBlock is implemented.
 * Typing indicators are managed by the bridge, not this handler.
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogFn = (level: string, message: string) => void;
type SendFn = (params: { channelId: string; text: string; replyTo?: string }) => Promise<void>;

// ---------------------------------------------------------------------------
// AgentStreamHandler
// ---------------------------------------------------------------------------

export class AgentStreamHandler extends BlockRenderer<string> {
  private log: LogFn;
  private send: SendFn;
  private lastActiveChannelId: string | null = null;

  constructor(
    send: SendFn,
    log: LogFn,
    options?: {
      verbose?: Partial<VerboseConfig>;
    },
  ) {
    super({
      flushIntervalMs: 500,
      minEditIntervalMs: 0, // send-only, no throttle needed
      verbose: options?.verbose,
    });
    this.send = send;
    this.log = log;
  }

  // ---- BlockRenderer overrides ----

  /** Prefix sessionId with channel kind. */
  protected sessionIdToChannelId(sessionId: string): string {
    return `weixin-openclaw-bridge:${sessionId}`;
  }

  /** WeChat uses plain text with emoji prefixes. */
  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `💭 ${content}`;
      case "tool":     return content.trim();
      case "text":     return content;
    }
  }

  /** Send block as a new message (no editing on WeChat). */
  protected async sendBlock(channelId: string, _kind: BlockKind, content: string): Promise<string | null> {
    try {
      await this.send({ channelId, text: content });
    } catch (e) {
      this.log("error", `sendBlock failed: ${e}`);
    }
    return null; // no message ref — send-only
  }

  // No editBlock — WeChat doesn't support message editing

  /** Cleanup after turn. */
  protected async onAfterTurnEnd(_channelId: string): Promise<void> {
    // Typing is managed by the bridge
  }

  /** Send error message. */
  protected async onAfterTurnError(channelId: string, error: string): Promise<void> {
    this.send({ channelId, text: `❌ Error: ${error}` }).catch((e) => {
      this.log("error", `send error notice failed: ${e}`);
    });
  }

  // ---- Prompt lifecycle ----

  onPromptSent(channelId: string): void {
    this.lastActiveChannelId = channelId;
    super.onPromptSent(channelId);
  }

  // ---- Host ext notification handlers ----

  onAgentReady(agent: string, version: string): void {
    const channelId = this.lastActiveChannelId;
    if (channelId) {
      this.send({ channelId, text: `🤖 Agent: ${agent} v${version}` }).catch(() => {});
    }
  }

  onSessionReady(sessionId: string): void {
    const channelId = this.lastActiveChannelId;
    if (channelId) {
      this.send({ channelId, text: `📋 Session: ${sessionId}` }).catch(() => {});
    }
  }

  onSendSystemText(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const text = params.text as string;
    const replyTo = params.replyTo as string | undefined;
    this.send({ channelId, text, replyTo }).catch((e) => {
      this.log("error", `send_system_text failed: ${e}`);
    });
  }
}
