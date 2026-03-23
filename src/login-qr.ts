import { randomUUID } from "node:crypto";

export const DEFAULT_ILINK_BOT_TYPE = "3";

interface ActiveLogin {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
}

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

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(raw) as StatusResponse;
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
}

export async function startWeixinLoginWithQr(opts: {
  accountId?: string;
  apiBaseUrl: string;
  botType?: string;
  force?: boolean;
}): Promise<{ qrcodeUrl?: string; message: string; sessionKey: string }> {
  const sessionKey = opts.accountId || randomUUID();
  const existing = activeLogins.get(sessionKey);
  if (!opts.force && existing && isLoginFresh(existing)) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: "QR code already generated.",
      sessionKey,
    };
  }

  const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
  const qr = await fetchQRCode(opts.apiBaseUrl, botType);
  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: Date.now(),
  });

  return {
    qrcodeUrl: qr.qrcode_img_content,
    message: "Scan the QR code with WeChat to authorize the bridge.",
    sessionKey,
  };
}

export async function waitForWeixinLogin(opts: {
  sessionKey: string;
  apiBaseUrl: string;
  timeoutMs?: number;
}): Promise<{
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
}> {
  const activeLogin = activeLogins.get(opts.sessionKey);
  if (!activeLogin || !isLoginFresh(activeLogin)) {
    return { connected: false, message: "QR session expired or missing." };
  }

  const deadline = Date.now() + Math.max(opts.timeoutMs ?? 480_000, 1000);
  while (Date.now() < deadline) {
    const status = await pollQRStatus(opts.apiBaseUrl, activeLogin.qrcode);
    if (status.status === "confirmed" && status.ilink_bot_id) {
      activeLogins.delete(opts.sessionKey);
      return {
        connected: true,
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        baseUrl: status.baseurl,
        userId: status.ilink_user_id,
        message: "WeChat authorization succeeded.",
      };
    }
    if (status.status === "expired") {
      activeLogins.delete(opts.sessionKey);
      return { connected: false, message: "QR code expired." };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return { connected: false, message: "Timed out waiting for QR confirmation." };
}
