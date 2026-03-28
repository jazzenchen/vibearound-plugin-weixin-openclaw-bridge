/**
 * AgentStreamHandler — receives ACP session updates and renders them as
 * separate WeChat messages, one per contiguous variant block.
 *
 * Each contiguous run of the same variant (thinking, tool, text) becomes
 * one WeChat message. When the variant changes, the current block is
 * "sealed" and sent immediately. No message editing — just sequential sends.
 *
 * Typing indicator stays on from prompt start until the last message is sent.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BlockKind = "thinking" | "tool" | "text";

interface MessageBlock {
  kind: BlockKind;
  content: string;
  sent: boolean;
}

interface ChannelState {
  blocks: MessageBlock[];
}

type LogFn = (level: string, message: string) => void;
type SendFn = (params: { channelId: string; text: string; replyTo?: string }) => Promise<void>;
type TypingFn = (channelId: string) => Promise<void>;

export interface VerboseConfig {
  showThinking: boolean;
  showToolUse: boolean;
}

export class AgentStreamHandler {
  private log: LogFn;
  private send: SendFn;
  private verbose: VerboseConfig;
  private startTyping?: TypingFn;
  private stopTyping?: TypingFn;
  private channels = new Map<string, ChannelState>();
  private lastActiveChannelId: string | null = null;

  constructor(
    send: SendFn,
    log: LogFn,
    options?: {
      startTyping?: TypingFn;
      stopTyping?: TypingFn;
      verbose?: Partial<VerboseConfig>;
    },
  ) {
    this.send = send;
    this.log = log;
    this.verbose = {
      showThinking: options?.verbose?.showThinking ?? false,
      showToolUse: options?.verbose?.showToolUse ?? false,
    };
    this.startTyping = options?.startTyping;
    this.stopTyping = options?.stopTyping;
  }

  /** Called when a prompt is sent — init state. Typing is handled by the bridge. */
  onPromptSent(channelId: string): void {
    this.lastActiveChannelId = channelId;
    this.channels.delete(channelId);
    this.channels.set(channelId, { blocks: [] });
  }

  /** Agent initialized — send info message. */
  onAgentReady(agent: string, version: string): void {
    const channelId = this.lastActiveChannelId;
    if (channelId) {
      this.send({ channelId, text: `🤖 Agent: ${agent} v${version}` }).catch(() => {});
    }
  }

  /** Session ready — send session info. */
  onSessionReady(sessionId: string): void {
    const channelId = this.lastActiveChannelId;
    if (channelId) {
      this.send({ channelId, text: `📋 Session: ${sessionId}` }).catch(() => {});
    }
  }

  // ---- ACP SessionUpdate dispatcher ----

  onSessionUpdate(notification: SessionNotification): void {
    const sessionId = notification.sessionId;
    const update = notification.update;
    const variant = (update as any).sessionUpdate as string;
    const channelId = `weixin-openclaw-bridge:${sessionId}`;

    switch (variant) {
      case "agent_message_chunk": {
        const content = (update as any).content as { text?: string } | undefined;
        const delta = content?.text ?? "";
        if (delta) this.appendToBlock(channelId, "text", delta);
        break;
      }
      case "agent_thought_chunk": {
        if (!this.verbose.showThinking) return;
        const content = (update as any).content as { text?: string } | undefined;
        const delta = content?.text ?? "";
        if (delta) this.appendToBlock(channelId, "thinking", delta);
        break;
      }
      case "tool_call": {
        if (!this.verbose.showToolUse) return;
        // ACP ToolCall: { toolCallId, title, kind, status, ... }
        const toolTitle = (update as any).title as string | undefined;
        if (toolTitle) this.appendToBlock(channelId, "tool", `🔧 ${toolTitle}\n`);
        break;
      }
      case "tool_call_update": {
        if (!this.verbose.showToolUse) return;
        const title = (update as any).title as string | undefined;
        const status = (update as any).status as string | undefined;
        const label = title ?? "tool";
        if (status === "completed" || status === "error") {
          this.appendToBlock(channelId, "tool", `✅ ${label}\n`);
        }
        break;
      }
      default:
        this.log("debug", `unhandled session update variant: ${variant}`);
    }
  }

  // ---- Turn lifecycle (called from bridge after prompt() returns) ----

  /** Turn ended — seal and send last block. Typing is stopped by the bridge. */
  onAgentEnd(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const state = this.channels.get(channelId);
    if (!state) return;

    // Seal and send the last block
    const last = state.blocks[state.blocks.length - 1];
    if (last && !last.sent) {
      last.sent = true;
      this.sendBlock(channelId, last);
    }

    this.channels.delete(channelId);
  }

  /** Turn errored — send error message. Typing is stopped by the bridge. */
  onAgentError(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const error = params.error as string;
    this.channels.delete(channelId);
    void this.send({ channelId, text: `❌ Error: ${error}` }).catch((e) => {
      this.log("error", `send error notice failed: ${e}`);
    });
  }

  /** Handle system text from host. */
  onSendSystemText(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const text = params.text as string;
    const replyTo = params.replyTo as string | undefined;
    void this.send({ channelId, text, replyTo }).catch((e) => {
      this.log("error", `send_system_text failed: ${e}`);
    });
  }

  // ---- Block management ----

  private appendToBlock(channelId: string, kind: BlockKind, delta: string): void {
    const state = this.channels.get(channelId);
    if (!state) return;

    const current = state.blocks.length > 0
      ? state.blocks[state.blocks.length - 1]
      : null;

    if (current && !current.sent && current.kind === kind) {
      // Same kind — append
      current.content += delta;
    } else {
      // Different kind — seal and send current, start new
      if (current && !current.sent) {
        current.sent = true;
        this.sendBlock(channelId, current);
      }
      state.blocks.push({ kind, content: delta, sent: false });
    }
  }

  private sendBlock(channelId: string, block: MessageBlock): void {
    const text = this.formatBlock(block);
    if (!text) return;
    void this.send({ channelId, text }).catch((e) => {
      this.log("error", `sendBlock failed: ${e}`);
    });
  }

  private formatBlock(block: MessageBlock): string {
    switch (block.kind) {
      case "thinking":
        return `💭 ${block.content}`;
      case "tool":
        return block.content.trim();
      case "text":
        return block.content;
    }
  }
}
