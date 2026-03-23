import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

function resolvePluginRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
}

function resolveSettingsPath(): string {
  return path.resolve(resolvePluginRoot(), "..", "..", "settings.json");
}

let cachedRouteTagSection: Record<string, unknown> | null | undefined;

function loadRouteTagSection(): Record<string, unknown> | null {
  if (cachedRouteTagSection !== undefined) return cachedRouteTagSection;
  try {
    const settingsPath = resolveSettingsPath();
    if (!fs.existsSync(settingsPath)) {
      cachedRouteTagSection = null;
      return null;
    }
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const section = (channels?.["weixin-openclaw-bridge"] as Record<string, unknown>) ?? null;
    cachedRouteTagSection = section;
    return section;
  } catch {
    cachedRouteTagSection = null;
    return null;
  }
}

export function loadConfigRouteTag(accountId?: string): string | undefined {
  const section = loadRouteTagSection();
  if (!section) return undefined;
  if (accountId) {
    const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
    const tag = accounts?.[accountId]?.routeTag;
    if (typeof tag === "number") return String(tag);
    if (typeof tag === "string" && tag.trim()) return tag.trim();
  }
  if (typeof section.routeTag === "number") return String(section.routeTag);
  return typeof section.routeTag === "string" && section.routeTag.trim() ? section.routeTag.trim() : undefined;
}
