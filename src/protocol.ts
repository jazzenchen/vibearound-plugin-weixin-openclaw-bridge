export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface WechatOpenClawBridgeConfig {
  base_url: string;
  bot_token?: string;
  account_id?: string;
}

export interface InitializeParams {
  config: WechatOpenClawBridgeConfig;
  hostVersion: string;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: PluginCapabilities;
  botInfo?: { id?: string; name: string };
}

export interface SenderInfo {
  id: string;
  name?: string;
  type?: "user" | "bot";
}

export interface OnMessageParams {
  channelId: string;
  messageId: string;
  chatType: "private";
  sender: SenderInfo;
  text: string;
  replyTo?: string;
}

export interface PluginCapabilities {
  streaming: boolean;
  interactiveCards: boolean;
  reactions: boolean;
  editMessage: boolean;
  media: boolean;
}

export interface LoginQrStartParams {
  baseUrl?: string;
  accountId?: string;
  force?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
}

export interface LoginQrWaitParams {
  baseUrl?: string;
  sessionKey: string;
  timeoutMs?: number;
  verbose?: boolean;
}
