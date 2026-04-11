#!/usr/bin/env node
/**
 * VibeAround WeChat OpenClaw Bridge Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * Communicates via ACP protocol (JSON-RPC 2.0 over stdio).
 *
 * Plugin = ACP Client, Host = ACP Agent.
 * Plugin sends prompt() with peerId as sessionId.
 * Host streams back via sessionUpdate notifications.
 */

import path from "node:path";
import os from "node:os";
import {
  connectToHost,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@vibearound/plugin-channel-sdk";

import { WechatOpenClawBridge } from "./wechat-bridge.js";
import { AgentStreamHandler } from "./agent-stream.js";
import type { WechatOpenClawBridgeConfig } from "./protocol.js";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let streamHandler: AgentStreamHandler | null = null;

function log(level: string, message: string): void {
  process.stderr.write(`[weixin-openclaw-bridge][${level}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Initialize — get channel config from host and start
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  log("info", "initializing ACP connection...");

  const { agent, meta, agentInfo, conn } = await connectToHost(
    { name: "vibearound-weixin-openclaw-bridge", version: "0.1.0" },
    (_a) => ({
      async sessionUpdate(params: SessionNotification): Promise<void> {
        streamHandler?.onSessionUpdate(params);
      },

      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        const first = params.options?.[0];
        if (first) {
          return { outcome: { outcome: "selected", optionId: first.optionId } };
        }
        throw new Error("No permission options provided");
      },

      async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
        switch (method) {
          case "channel/system_text": {
            streamHandler?.onSendSystemText(params);
            break;
          }
          case "channel/agent_ready": {
            const agentName = params.agent as string;
            const version = params.version as string;
            log("info", `agent_ready: ${agentName} v${version}`);
            streamHandler?.onAgentReady(agentName, version);
            break;
          }
          case "channel/session_ready": {
            const sessionId = params.sessionId as string;
            log("info", `session_ready: ${sessionId}`);
            streamHandler?.onSessionReady(sessionId);
            break;
          }
          default:
            log("warn", `unhandled ext_notification: ${method}`);
        }
      },
    }),
  );

  const config = meta.config as unknown as WechatOpenClawBridgeConfig;
  const cacheDir = meta.cacheDir ?? path.join(os.homedir(), ".vibearound", ".cache");

  log("info", `initialized, host=${agentInfo.name ?? "unknown"} cacheDir=${cacheDir}`);

  // Create bridge
  const bridge = new WechatOpenClawBridge(config, agent, log, cacheDir);

  // Parse verbose config
  const verbose = (config as unknown as Record<string, unknown>).verbose as
    | { show_thinking?: boolean; show_tool_use?: boolean }
    | undefined;

  // Create stream handler
  streamHandler = new AgentStreamHandler(
    (payload) => bridge.sendSystemText(payload),
    log,
    {
      verbose: {
        showThinking: verbose?.show_thinking ?? false,
        showToolUse: verbose?.show_tool_use ?? false,
      },
    },
  );

  // Wire bridge callbacks to stream handler
  bridge.setPromptCallback((channelId) => streamHandler?.onPromptSent(channelId));
  bridge.setTurnCallbacks(
    ({ channelId }) => { streamHandler?.onTurnEnd(channelId); },
    ({ channelId, error }) => { streamHandler?.onTurnError(channelId, error); },
  );

  const botInfo = await bridge.probe();
  log("info", `bot probed: ${JSON.stringify(botInfo)}`);
  bridge.start();

  log("info", "plugin started");

  // Wait for connection to close
  await conn.closed;
  log("info", "connection closed, shutting down");
  bridge.stop();
  process.exit(0);
}

start().catch((error) => {
  log("error", `fatal: ${error}`);
  process.exit(1);
});
