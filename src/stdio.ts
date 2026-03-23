import { createInterface } from "node:readline";
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./protocol.js";

type RequestHandler = (params: Record<string, unknown>) => Promise<unknown>;
type NotificationHandler = (params: Record<string, unknown>) => void;

export class StdioTransport {
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private pendingRequests = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private rl: ReturnType<typeof createInterface> | null = null;

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  start(): void {
    this.rl = createInterface({ input: process.stdin, terminal: false });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this.handleMessage(JSON.parse(trimmed) as JsonRpcMessage);
      } catch (error) {
        this.log("error", `parse failed: ${error}`);
      }
    });
    this.rl.on("close", () => {
      this.log("warn", "stdin closed — host disconnected");
    });
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  log(level: string, message: string): void {
    process.stderr.write(`[weixin-openclaw-bridge][${level}] ${message}\n`);
    this.notify("plugin_log", { level, message });
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if ("result" in message || "error" in message) {
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        response.error
          ? pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
          : pending.resolve(response.result);
      }
      return;
    }

    if ("id" in message && message.id != null) {
      const request = message as JsonRpcRequest;
      const handler = this.requestHandlers.get(request.method);
      if (!handler) {
        this.write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        });
        return;
      }
      try {
        const result = await handler(request.params ?? {});
        this.write({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        this.write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    const notification = message as JsonRpcNotification;
    this.notificationHandlers.get(notification.method)?.(notification.params ?? {});
  }

  private write(message: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(message) + "\n");
  }
}
