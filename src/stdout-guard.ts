/**
 * stdout-guard.ts — MUST be the first import in main.ts.
 *
 * Keeps stdout reserved for JSON-RPC payloads and redirects incidental logs to stderr.
 */

import { inspect } from "node:util";

const originalWrite = process.stdout.write.bind(process.stdout);

type LogSink = (level: string, message: string) => void;
let logSink: LogSink | null = null;

process.stdout.write = function (chunk: any, ..._args: any[]): boolean {
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      originalWrite(line + "\n");
    } else {
      process.stderr.write("[stdout-guard] " + line + "\n");
    }
  }
  return true;
} as any;

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return inspect(value, { depth: 3, colors: false, maxStringLength: 2000 });
  }
}

export function setLogSink(sink: LogSink): void {
  logSink = sink;
}

console.log = (...args: unknown[]) => {
  process.stderr.write(args.map(serialize).join(" ") + "\n");
};
console.info = console.log;
console.debug = (...args: unknown[]) => {
  process.stderr.write("[debug] " + args.map(serialize).join(" ") + "\n");
};
console.warn = (...args: unknown[]) => {
  const message = args.map(serialize).join(" ");
  process.stderr.write(`[warn] ${message}\n`);
  logSink?.("warn", message);
};
console.error = (...args: unknown[]) => {
  const message = args.map(serialize).join(" ");
  process.stderr.write(`[error] ${message}\n`);
  logSink?.("error", message);
};
