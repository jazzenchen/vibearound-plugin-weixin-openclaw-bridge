import fs from "node:fs/promises";
import path from "node:path";

export function buildCachePath(params: {
  cacheDir: string;
  channelKind: string;
  chatId: string;
  messageId: string;
  ext: string;
}): string {
  const { cacheDir, channelKind, chatId, messageId, ext } = params;
  return path.join(cacheDir, channelKind, chatId, `${messageId}${ext}`);
}

export async function isCached(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeCacheFile(filePath: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}
