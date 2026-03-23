import type { MessageItem, WeixinMessage } from "../api/types.js";
import { MessageItemType, MessageType } from "../api/types.js";
import { logger } from "../util/logger.js";

const contextTokenStore = new Map<string, string>();

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

export function setContextToken(accountId: string, userId: string, token: string): void {
  contextTokenStore.set(contextTokenKey(accountId, userId), token);
}

export function getContextToken(accountId: string, userId: string): string | undefined {
  return contextTokenStore.get(contextTokenKey(accountId, userId));
}

export function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text).trim();
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text.trim();
    }
  }
  return "";
}

export function extractInboundText(message: WeixinMessage): string {
  return bodyFromItemList(message.item_list);
}

export function shouldHandleInboundMessage(message: WeixinMessage): boolean {
  if (!message.from_user_id) return false;
  if (message.message_type != null && message.message_type !== MessageType.USER) {
    logger.debug(
      `skip inbound message_id=${String(message.message_id ?? "")} message_type=${String(message.message_type)}`,
    );
    return false;
  }
  return true;
}
