import crypto from "node:crypto";

export interface WeixinApiOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export interface TextItem {
  text?: string;
}

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
}

export interface WeixinMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

const MESSAGE_ITEM_TYPE_TEXT = 1;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(body: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(params.body, params.token),
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status}: ${rawText}`);
    }
    return rawText;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  get_updates_buf?: string;
}): Promise<GetUpdatesResp> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const raw = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({ get_updates_buf: params.get_updates_buf ?? "", base_info: {} }),
      token: params.token,
      timeoutMs,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf ?? "" };
    }
    throw error;
  }
}

export async function sendTextMessage(params: {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
}): Promise<{ messageId: string }> {
  const clientId = `weixin-openclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [
          {
            type: MESSAGE_ITEM_TYPE_TEXT,
            text_item: { text: params.text },
          },
        ],
        context_token: params.contextToken,
      },
      base_info: {},
    }),
  });
  return { messageId: clientId };
}

export function extractText(message: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type === MESSAGE_ITEM_TYPE_TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    }
  }
  return parts.join("\n").trim();
}
