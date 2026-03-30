#!/usr/bin/env node
/**
 * WeChat standalone auth script for onboarding.
 *
 * Spawned by the Rust onboarding backend as a JSON-RPC subprocess.
 * Handles login_qr_start / login_qr_wait via the WeChat OpenClaw Bridge API.
 * Does NOT use the ACP SDK — speaks raw JSON-RPC directly.
 *
 * JSON-RPC methods:
 *   initialize → handshake
 *   login_qr_start → fetch QR code from WeChat API
 *   login_qr_wait → poll until user scans and confirms
 *   shutdown → clean exit
 */

import { createInterface } from "node:readline";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "./auth/login-qr.js";

function sendJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResponse(id: number | string, result: unknown): void {
  sendJson({ jsonrpc: "2.0", id, result });
}

function sendError(id: number | string, message: string): void {
  sendJson({ jsonrpc: "2.0", id, error: { code: -1, message } });
}

function log(msg: string): void {
  process.stderr.write(`[weixin-auth] ${msg}\n`);
}

// Redirect console to stderr
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
console.info = console.log;
console.warn = (...args: unknown[]) => process.stderr.write(`[warn] ${args.map(String).join(" ")}\n`);
console.error = (...args: unknown[]) => process.stderr.write(`[error] ${args.map(String).join(" ")}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      sendResponse(id, {
        protocolVersion: "2025-03-26",
        agentInfo: { name: "weixin-auth", version: "0.1.0" },
      });
      break;
    }

    case "login_qr_start": {
      const baseUrl = params?.baseUrl as string;
      if (!baseUrl) {
        sendError(id, "baseUrl is required");
        break;
      }
      log(`starting QR login, baseUrl=${baseUrl}`);
      try {
        const result = await startWeixinLoginWithQr({
          apiBaseUrl: baseUrl,
          force: true,
        });
        sendResponse(id, {
          qrcodeUrl: result.qrcodeUrl ?? null,
          message: result.message,
          sessionKey: result.sessionKey,
        });
      } catch (e) {
        sendError(id, String(e));
      }
      break;
    }

    case "login_qr_wait": {
      const baseUrl = params?.baseUrl as string;
      const sessionKey = params?.sessionKey as string;
      const timeoutMs = params?.timeoutMs as number | undefined;
      if (!baseUrl || !sessionKey) {
        sendError(id, "baseUrl and sessionKey are required");
        break;
      }
      log(`waiting for QR confirmation, sessionKey=${sessionKey}`);
      try {
        const result = await waitForWeixinLogin({
          apiBaseUrl: baseUrl,
          sessionKey,
          timeoutMs,
        });
        sendResponse(id, result);
      } catch (e) {
        sendError(id, String(e));
      }
      break;
    }

    case "shutdown": {
      sendResponse(id, {});
      setTimeout(() => process.exit(0), 500);
      break;
    }

    default:
      sendError(id, `unknown method: ${method}`);
  }
});
