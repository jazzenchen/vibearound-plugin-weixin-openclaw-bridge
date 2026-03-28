# VibeAround Weixin OpenClaw Bridge Plugin

Weixin channel plugin for VibeAround. Communicates with the Rust host via stdio JSON-RPC 2.0.

This plugin is implemented in-project and is not directly dependent on `@tencent-weixin/openclaw-weixin`, but its design and protocol path reference the OpenClaw Weixin ecosystem and the package [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin).

It provides channel capabilities through the WeChat OpenClaw bot flow and a compatible OpenClaw / iLink-style HTTP API.

## Architecture

```
WeChat User ←→ OpenClaw / iLink HTTP API ←→ Plugin (Node.js) ←→ stdio JSON-RPC ←→ Rust Host
```

The plugin runs as a child process of the host. Messages are exchanged over stdin/stdout:
- Host → Plugin: `initialize`, `login_qr_start`, `login_qr_wait`, `shutdown`, agent stream notifications
- Plugin → Host: `on_message`, `plugin_log`

## Features

- **Block-based rendering**: each contiguous run of the same variant (thinking, tool use, text) is sent as a separate message. When the variant changes, the current block is sealed and a new message starts.
- **sendChain message ordering**: all `flushBlock` calls are serialized via a promise chain to prevent out-of-order delivery
- **Typing await before prompt**: `startTyping()` is awaited before calling `prompt()`, ensuring the typing indicator is visible before the agent turn can complete
- QR login flow for WeChat OpenClaw bot authorization
- Long-polling inbound message consumption via `ilink/bot/getupdates`
- Outbound text message sending via `ilink/bot/sendmessage`
- Context token propagation for follow-up replies
- Lightweight stdio JSON-RPC bridge for VibeAround channel integration
- Compatible with `base_url`-driven OpenClaw / iLink-style deployments
- `/help` slash command returns cached agent commands + system commands

## Project Structure

```
src/
├── main.ts                 # Entry point, JSON-RPC router
├── stdio.ts                # JSON-RPC 2.0 transport
├── protocol.ts             # Host ↔ Plugin protocol types
├── stdout-guard.ts         # Protects stdout for protocol-only output
├── wechat-bridge.ts        # Bridge state, polling loop, message dispatch
├── weixin-api.ts           # OpenClaw / iLink HTTP API wrapper
├── login-qr.ts             # QR login start and confirmation polling
└── agent-stream.ts         # Agent event aggregation into outbound text
```

## Development

```bash
npm install
npm run build

# Watch mode
npm run dev
```

## Configuration

Add to VibeAround's `settings.json`:

```json
{
  "channels": {
    "weixin-openclaw-bridge": {
      "base_url": "https://ilinkai.weixin.qq.com",
      "bot_token": "optional-after-login",
      "account_id": "optional-after-login"
    }
  }
}
```

### Required Configuration

- `base_url`: Base URL of the compatible OpenClaw / iLink WeChat provider
- `bot_token`: Bot token returned after QR login
- `account_id`: Optional account identifier returned after authorization

## Manual Testing

```bash
npm run build
npm start
```

Then initialize the plugin from the VibeAround host, start QR login, scan with WeChat, and verify inbound and outbound text messaging.

## Protocol

JSON-RPC 2.0 over stdio, newline-delimited. See `src/protocol.ts` for details.

## Acknowledgements

This plugin references the design and usage path of [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) and implements an in-project bridge tailored for VibeAround.
