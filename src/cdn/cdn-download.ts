/**
 * CDN download & decrypt for inbound WeChat media.
 * Based on @tencent-weixin/openclaw-weixin (MIT).
 */

import { decryptAesEcb } from "./aes-ecb.js";
import { logger } from "../util/logger.js";

const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DOWNLOAD_MAX_RETRIES = 3;

/**
 * Build a CDN download URL from encrypt_query_param.
 */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string = DEFAULT_CDN_BASE_URL): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)           → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  const msg = `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`;
  logger.error(msg);
  throw new Error(msg);
}

/**
 * Download raw bytes from the CDN.
 */
async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => "(unreadable)");
        throw new Error(`${label}: CDN download client error ${res.status}: ${body}`);
      }
      if (!res.ok) {
        throw new Error(`${label}: CDN download ${res.status} ${res.statusText}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt < DOWNLOAD_MAX_RETRIES) {
        logger.warn(`${label}: attempt ${attempt} failed, retrying... err=${String(err)}`);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label}: CDN download failed after ${DOWNLOAD_MAX_RETRIES} attempts`);
}

/**
 * Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer.
 */
export async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label);
  const url = fullUrl ?? buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  logger.debug(`${label}: fetching url=${url.slice(0, 80)}...`);
  const encrypted = await fetchCdnBytes(url, label);
  logger.debug(`${label}: downloaded ${encrypted.byteLength} bytes, decrypting`);
  const decrypted = decryptAesEcb(encrypted, key);
  logger.debug(`${label}: decrypted ${decrypted.length} bytes`);
  return decrypted;
}

/**
 * Download plain (unencrypted) bytes from the CDN.
 */
export async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const url = fullUrl ?? buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  logger.debug(`${label}: fetching url=${url.slice(0, 80)}...`);
  return fetchCdnBytes(url, label);
}
