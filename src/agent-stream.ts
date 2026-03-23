interface ChannelState {
  text: string;
  thinking: string;
  toolLines: string[];
}

type LogFn = (level: string, message: string) => void;

type SendFn = (params: { channelId: string; text: string; replyTo?: string }) => Promise<void>;
type TypingFn = (channelId: string) => Promise<void>;

export class AgentStreamHandler {
  private log: LogFn;
  private send: SendFn;
  private startTyping?: TypingFn;
  private stopTyping?: TypingFn;
  private channels = new Map<string, ChannelState>();

  constructor(send: SendFn, log: LogFn, options?: { startTyping?: TypingFn; stopTyping?: TypingFn }) {
    this.send = send;
    this.log = log;
    this.startTyping = options?.startTyping;
    this.stopTyping = options?.stopTyping;
  }

  onAgentStart(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    this.channels.set(channelId, {
      text: "",
      thinking: "",
      toolLines: [],
    });
    void this.startTyping?.(channelId).catch((error) => {
      this.log("warn", `start typing failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.log("debug", `agent_start channel=${channelId}`);
  }

  onAgentThinking(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const text = params.text as string;
    const state = this.channels.get(channelId);
    if (!state) return;
    state.thinking = text;
  }

  onAgentToken(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const delta = params.delta as string;
    const state = this.channels.get(channelId);
    if (!state) return;
    state.text += delta;
  }

  onAgentToolUse(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const tool = params.tool as string;
    const state = this.channels.get(channelId);
    if (!state) return;
    state.toolLines.push(`🔧 ${tool}`);
  }

  onAgentToolResult(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const tool = params.tool as string;
    this.log("debug", `agent_tool_result channel=${channelId} tool=${tool}`);
  }

  onAgentEnd(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const state = this.channels.get(channelId);
    if (!state) return;

    const content = this.buildContent(state);
    this.channels.delete(channelId);
    void this.stopTyping?.(channelId).catch((error) => {
      this.log("warn", `stop typing failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    if (!content) {
      this.log("debug", `agent_end channel=${channelId} with empty content`);
      return;
    }

    void this.send({ channelId, text: content }).catch((error) => {
      this.log(
        "error",
        `send aggregated reply failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  onAgentError(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const error = params.error as string;
    this.channels.delete(channelId);
    void this.stopTyping?.(channelId).catch(() => {});

    void this.send({ channelId, text: `❌ Error: ${error}` }).catch((sendError) => {
      this.log(
        "error",
        `send error notice failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
      );
    });
  }

  onSendSystemText(params: Record<string, unknown>): void {
    const channelId = params.channelId as string;
    const text = params.text as string;
    const replyTo = params.replyTo as string | undefined;
    void this.stopTyping?.(channelId).catch(() => {});

    void this.send({ channelId, text, replyTo }).catch((error) => {
      this.log(
        "error",
        `send_system_text failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private buildContent(state: ChannelState): string {
    const parts: string[] = [];

    if (state.thinking && !state.text) {
      parts.push(`💭 ${state.thinking}`);
    }

    if (state.toolLines.length > 0) {
      parts.push(state.toolLines.join("\n"));
    }

    if (state.text) {
      parts.push(state.text);
    }

    return parts.join("\n\n").trim();
  }
}
