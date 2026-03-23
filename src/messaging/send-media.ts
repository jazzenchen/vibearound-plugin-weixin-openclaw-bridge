import path from "node:path";

import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { getMimeFromFilename } from "../media/mime.js";
import { sendFileMessageWeixin, sendImageMessageWeixin, sendVideoMessageWeixin } from "./send.js";
import { uploadFileAttachmentToWeixin, uploadFileToWeixin, uploadVideoToWeixin } from "../cdn/upload.js";

export async function sendWeixinMediaFile(params: {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
  const mime = getMimeFromFilename(filePath);
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };

  if (mime.startsWith("video/")) {
    const uploaded = await uploadVideoToWeixin({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl });
    return sendVideoMessageWeixin({ to, text, uploaded, opts });
  }

  if (mime.startsWith("image/")) {
    const uploaded = await uploadFileToWeixin({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl });
    return sendImageMessageWeixin({ to, text, uploaded, opts });
  }

  const fileName = path.basename(filePath);
  logger.info(`sendWeixinMediaFile: uploading file attachment ${fileName} to=${to}`);
  const uploaded = await uploadFileAttachmentToWeixin({
    filePath,
    fileName,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
  });
  return sendFileMessageWeixin({ to, text, fileName, uploaded, opts });
}
