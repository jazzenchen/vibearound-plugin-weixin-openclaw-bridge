import { randomUUID } from "node:crypto";

import { loadConfigRouteTag } from "./accounts.js";
import { logger } from "../util/logger.js";
import { redactToken } from "../util/redact.js";

export const DEFAULT_ILINK_BOT_TYPE = "3";

type ActiveLogin = {
  sessionKey: string;
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  botToken?: string;
  status?: "wait" | "scaned" | "confirmed" | "expired";
  error?: string;
};

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const activeLogins = new Map<string, ActiveLogin>();

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(id);
  }
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const headers: Record<string, string> = {};
  const routeTag = loadConfigRouteTag();
  if (routeTag) headers.SKRouteTag = routeTag;
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    logger.error(`QR code fetch failed: ${response.status} ${response.statusText} body=${body}`);
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const headers: Record<string, string> = { "iLink-App-ClientVersion": "1" };
  const routeTag = loadConfigRouteTag();
  if (routeTag) headers.SKRouteTag = routeTag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      logger.error(`QR status poll failed: ${response.status} ${response.statusText} body=${rawText}`);
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

export type WeixinQrStartResult = {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
};

export type WeixinQrWaitResult = {
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
};

export async function startWeixinLoginWithQr(opts: {
  verbose?: boolean;
  timeoutMs?: number;
  force?: boolean;
  accountId?: string;
  apiBaseUrl: string;
  botType?: string;
}): Promise<WeixinQrStartResult> {
  const sessionKey = opts.accountId || randomUUID();
  purgeExpiredLogins();
  const existing = activeLogins.get(sessionKey);
  if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return { qrcodeUrl: existing.qrcodeUrl, message: "二维码已就绪，请使用微信扫描。", sessionKey };
  }
  try {
    const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
    const qrResponse = await fetchQRCode(opts.apiBaseUrl, botType);
    logger.info(`QR code received, qrcode=${redactToken(qrResponse.qrcode)} imgContentLen=${qrResponse.qrcode_img_content?.length ?? 0}`);
    activeLogins.set(sessionKey, {
      sessionKey,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
    });
    return {
      qrcodeUrl: qrResponse.qrcode_img_content,
      message: "使用微信扫描以下二维码，以完成连接。",
      sessionKey,
    };
  } catch (err) {
    logger.error(`Failed to start Weixin login: ${String(err)}`);
    return { message: `Failed to start login: ${String(err)}`, sessionKey };
  }
}

export async function waitForWeixinLogin(opts: {
  timeoutMs?: number;
  verbose?: boolean;
  sessionKey: string;
  apiBaseUrl: string;
  botType?: string;
}): Promise<WeixinQrWaitResult> {
  const activeLogin = activeLogins.get(opts.sessionKey);
  if (!activeLogin) {
    return { connected: false, message: "当前没有进行中的登录，请先发起登录。" };
  }
  if (!isLoginFresh(activeLogin)) {
    activeLogins.delete(opts.sessionKey);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }
  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const statusResponse = await pollQRStatus(opts.apiBaseUrl, activeLogin.qrcode);
      activeLogin.status = statusResponse.status;
      switch (statusResponse.status) {
        case "wait":
        case "scaned":
          break;
        case "expired":
          activeLogins.delete(opts.sessionKey);
          return { connected: false, message: "二维码已过期，请重新生成。" };
        case "confirmed":
          if (!statusResponse.ilink_bot_id) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: "登录失败：服务器未返回 ilink_bot_id。" };
          }
          activeLogin.botToken = statusResponse.bot_token;
          activeLogins.delete(opts.sessionKey);
          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "✅ 与微信连接成功！",
          };
      }
    } catch (err) {
      logger.error(`Error polling QR status: ${String(err)}`);
      activeLogins.delete(opts.sessionKey);
      return { connected: false, message: `登录失败: ${String(err)}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { connected: false, message: "Timed out waiting for QR confirmation." };
}
