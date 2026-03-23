import path from "node:path";

import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";

function generateClientId(): string {
  return generateId("weixin-openclaw-bridge");
}

export function markdownToPlainText(text: string): string {
  let result = text;
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) => inner.split("|").map((cell) => cell.trim()).join("  "));
  result = result.replace(/[*_~`>#-]/g, "");
  return result.trim();
}

function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
    },
  };
}

export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  const clientId = generateClientId();
  const req = buildTextMessageReq({
    to,
    text,
    contextToken: opts.contextToken,
    clientId,
  });
  await sendMessageApi({
    baseUrl: opts.baseUrl,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    body: req,
  });
  return { messageId: clientId };
}

async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
  label: string;
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts, label } = params;
  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  for (const item of items) {
    lastClientId = generateClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken ?? undefined,
      },
    };
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
  }

  logger.info(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId };
}

export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: "sendImageMessageWeixin" });
}

export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };
  return sendMediaItems({ to, text, mediaItem: videoItem, opts, label: "sendVideoMessageWeixin" });
}

export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, fileName, uploaded, opts } = params;
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
  return sendMediaItems({ to, text, mediaItem: fileItem, opts, label: "sendFileMessageWeixin" });
}

export function guessFileName(mediaPath: string): string {
  return path.basename(mediaPath);
}
