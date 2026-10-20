# codex-bridge

**Use any OpenCode Go model from Codex.**

Codex 0.163 dropped `wire_api = "chat"`, so most OpenCode Go models
(DeepSeek, Kimi, GLM, Qwen, ...) can no longer be reached directly.
This proxy translates between the two protocols.

```
Codex  ──/v1/responses──▶  codex-bridge  ──/chat/completions──▶  OpenCode Go
```

## Features

- Every OpenCode Go model selectable inside Codex
- Image input (for models that support vision)
- `reasoning_effort` mapped to temperature + instructions
- Per-thread token and cost tracking (`http://127.0.0.1:8788/usage`)
- Reuses your OpenCode login (OAuth) — **no API key required**
- Automatic fallback to `/responses` for models that reject `chat/completions`
- Runaway guard (429 after N requests per minute)

## Quick start

```bash
git clone https://github.com/nanameru/codex-bridge.git
cd codex-bridge
./scripts/install.sh
cd src && node codex-bridge.mjs
```

In another terminal:

```bash
./scripts/switch.sh on    # rewrites ~/.codex/config.toml and restarts the app
```

## Requirements

- Node.js 20+
- Codex CLI 0.163+ (or the ChatGPT desktop app with Codex)
- An OpenCode Go subscription, logged in (or `OPENCODE_API_KEY`)

## Not supported

- Native Codex `computer_use` tool (gated to OpenAI-authenticated providers);
  use the bundled `cua_repl` MCP instead
- In-app cost display (Codex computes it from OpenAI's price table)
- Built-in tools such as `web_search`

## License

MIT
