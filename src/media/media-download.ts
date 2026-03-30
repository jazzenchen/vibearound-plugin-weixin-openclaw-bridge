/**
 * Download and cache inbound media from WeChat messages.
 * Based on @tencent-weixin/openclaw-weixin (MIT).
 */

import type { MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from "../cdn/cdn-download.js";
import { buildCachePath, isCached, writeCacheFile } from "../cdn/media-cache.js";
import { getMimeFromFilename } from "./mime.js";
import { logger } from "../util/logger.js";

export interface DownloadedMedia {
  type: "image" | "voice" | "file" | "video";
  path: string;
  mimeType: string;
  fileName?: string;
}

const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100MB

/**
 * Download and cache media from a single MessageItem.
 * Returns null on unsupported type or failure.
 */
export async function downloadMediaItem(params: {
  item: MessageItem;
  cdnBaseUrl: string;
  cacheDir: string;
  channelKind: string;
  chatId: string;
  messageId: string;
  label: string;
}): Promise<DownloadedMedia | null> {
  const { item, cdnBaseUrl, cacheDir, channelKind, chatId, messageId, label } = params;

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param && !(img?.media as any)?.full_url) return null;
    const media = img!.media!;
    const aesKeyBase64 = img!.aeskey
      ? Buffer.from(img!.aeskey, "hex").toString("base64")
      : media.aes_key;

    const cachePath = buildCachePath({ cacheDir, channelKind, chatId, messageId, ext: ".jpg" });
    if (await isCached(cachePath)) {
      logger.debug(`${label} image: cache hit ${cachePath}`);
      return { type: "image", path: cachePath, mimeType: "image/jpeg" };
    }

    try {
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(
            media.encrypt_query_param ?? "",
            aesKeyBase64,
            cdnBaseUrl,
            `${label} image`,
            (media as any)?.full_url,
          )
        : await downloadPlainCdnBuffer(
            media.encrypt_query_param ?? "",
            cdnBaseUrl,
            `${label} image-plain`,
            (media as any)?.full_url,
          );
      if (buf.length > MAX_MEDIA_BYTES) {
        logger.warn(`${label} image: too large ${buf.length} bytes, skipping`);
        return null;
      }
      await writeCacheFile(cachePath, buf);
      logger.debug(`${label} image: saved ${cachePath}`);
      return { type: "image", path: cachePath, mimeType: "image/jpeg" };
    } catch (err) {
      logger.error(`${label} image download/decrypt failed: ${String(err)}`);
      return null;
    }
  }

  if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if ((!fileItem?.media?.encrypt_query_param && !(fileItem?.media as any)?.full_url) || !fileItem?.media?.aes_key)
      return null;
    const fileName = fileItem.file_name ?? "file.bin";
    const mime = getMimeFromFilename(fileName);
    const ext = fileName.includes(".") ? `.${fileName.split(".").pop()}` : ".bin";
    const cachePath = buildCachePath({ cacheDir, channelKind, chatId, messageId, ext });
    if (await isCached(cachePath)) {
      logger.debug(`${label} file: cache hit ${cachePath}`);
      return { type: "file", path: cachePath, mimeType: mime, fileName };
    }

    try {
      const buf = await downloadAndDecryptBuffer(
        fileItem.media.encrypt_query_param ?? "",
        fileItem.media.aes_key,
        cdnBaseUrl,
        `${label} file`,
        (fileItem.media as any)?.full_url,
      );
      if (buf.length > MAX_MEDIA_BYTES) {
        logger.warn(`${label} file: too large ${buf.length} bytes, skipping`);
        return null;
      }
      await writeCacheFile(cachePath, buf);
      logger.debug(`${label} file: saved ${cachePath} mime=${mime}`);
      return { type: "file", path: cachePath, mimeType: mime, fileName };
    } catch (err) {
      logger.error(`${label} file download failed: ${String(err)}`);
      return null;
    }
  }

  if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if ((!videoItem?.media?.encrypt_query_param && !(videoItem?.media as any)?.full_url) || !videoItem?.media?.aes_key)
      return null;
    const cachePath = buildCachePath({ cacheDir, channelKind, chatId, messageId, ext: ".mp4" });
    if (await isCached(cachePath)) {
      logger.debug(`${label} video: cache hit ${cachePath}`);
      return { type: "video", path: cachePath, mimeType: "video/mp4" };
    }

    try {
      const buf = await downloadAndDecryptBuffer(
        videoItem.media.encrypt_query_param ?? "",
        videoItem.media.aes_key,
        cdnBaseUrl,
        `${label} video`,
        (videoItem.media as any)?.full_url,
      );
      if (buf.length > MAX_MEDIA_BYTES) {
        logger.warn(`${label} video: too large ${buf.length} bytes, skipping`);
        return null;
      }
      await writeCacheFile(cachePath, buf);
      logger.debug(`${label} video: saved ${cachePath}`);
      return { type: "video", path: cachePath, mimeType: "video/mp4" };
    } catch (err) {
      logger.error(`${label} video download failed: ${String(err)}`);
      return null;
    }
  }

  // VOICE: skip for now (would need silk-to-wav transcoding)
  return null;
}
