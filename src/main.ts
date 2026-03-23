#!/usr/bin/env node

import "./stdout-guard.js";
import { setLogSink } from "./stdout-guard.js";

import { StdioTransport } from "./stdio.js";
import { WechatOpenClawBridge } from "./wechat-bridge.js";
import { AgentStreamHandler } from "./agent-stream.js";
import type {
  InitializeParams,
  InitializeResult,
  LoginQrStartParams,
  LoginQrWaitParams,
  WechatOpenClawBridgeConfig,
} from "./protocol.js";

const transport = new StdioTransport();
setLogSink((level, message) => {
  transport.notify("plugin_log", { level, message });
});

let bridge: WechatOpenClawBridge | null = null;
let streamHandler: AgentStreamHandler | null = null;

function log(level: string, message: string): void {
  process.stderr.write(`[weixin-openclaw-bridge][${level}] ${message}\n`);
}

transport.onRequest("initialize", async (params) => {
  const { config, hostVersion } = params as unknown as InitializeParams;
  const cfg = config as WechatOpenClawBridgeConfig;

  log("info", `initialize hostVersion=${hostVersion}`);

  if (!cfg.base_url) {
    throw new Error("base_url is required in WeChat OpenClaw Bridge config");
  }

  bridge = new WechatOpenClawBridge(cfg, transport, log);
  streamHandler = new AgentStreamHandler(
    (payload) => bridge!.sendSystemText(payload),
    log,
    {
      startTyping: (channelId) => bridge!.startTyping(channelId),
      stopTyping: (channelId) => bridge!.stopTyping(channelId),
    },
  );
  const botInfo = await bridge.probe();
  bridge.start();

  const result: InitializeResult = {
    protocolVersion: "0.2.0",
    capabilities: {
      streaming: false,
      interactiveCards: false,
      reactions: false,
      editMessage: false,
      media: false,
    },
    botInfo,
  };
  return result;
});

transport.onRequest("login_qr_start", async (params) => {
  if (!bridge) {
    throw new Error("bridge is not initialized");
  }
  return bridge.loginQrStart(params as unknown as LoginQrStartParams);
});

transport.onRequest("login_qr_wait", async (params) => {
  if (!bridge) {
    throw new Error("bridge is not initialized");
  }
  return bridge.loginQrWait(params as unknown as LoginQrWaitParams);
});

transport.onNotification("agent_start", (params) => {
  streamHandler?.onAgentStart(params);
});

transport.onNotification("agent_thinking", (params) => {
  streamHandler?.onAgentThinking(params);
});

transport.onNotification("agent_token", (params) => {
  streamHandler?.onAgentToken(params);
});

transport.onNotification("agent_tool_use", (params) => {
  streamHandler?.onAgentToolUse(params);
});

transport.onNotification("agent_tool_result", (params) => {
  streamHandler?.onAgentToolResult(params);
});

transport.onNotification("agent_end", (params) => {
  streamHandler?.onAgentEnd(params);
});

transport.onNotification("agent_error", (params) => {
  streamHandler?.onAgentError(params);
});

transport.onNotification("send_system_text", (params) => {
  streamHandler?.onSendSystemText(params);
});

transport.onRequest("shutdown", async () => {
  log("info", "shutdown requested");
  bridge?.stop();
  setTimeout(() => process.exit(0), 200);
  return { ok: true };
});

transport.start();
log("info", "plugin started, waiting for initialize...");
