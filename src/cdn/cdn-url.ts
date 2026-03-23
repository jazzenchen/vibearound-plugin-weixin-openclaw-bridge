export function buildCdnUploadUrl(params: { cdnBaseUrl: string; uploadParam: string; filekey: string }): string {
  const base = params.cdnBaseUrl.endsWith("/") ? params.cdnBaseUrl.slice(0, -1) : params.cdnBaseUrl;
  const query = new URLSearchParams({ upload_param: params.uploadParam, filekey: params.filekey });
  return `${base}?${query.toString()}`;
}
