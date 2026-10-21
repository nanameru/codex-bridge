# codex-bridge

## Switch both ways in the same chat

Unified mode routes native GPT models to OpenAI and `opencode/…` models to the
existing OpenCode bridge, regardless of whether the chat uses `openai` or `codex-bridge`.
It forwards Codex authentication only to OpenAI and strips account/auth headers from
the OpenCode route. No credential files are copied.

With Node.js 22.16+, Python 3.11+, both model catalogs and the existing bridge running:

```bash
python3 scripts/unified_config.py prepare
python3 scripts/install_router_service.py
python3 scripts/unified_config.py on
```

Reopen the app after active work finishes to refresh existing connections. Then
switch models within a chat without forking it. `unified_config.py off` restores
the previous routing settings. Model-specific tools and context limits still apply;
opaque compacted history cannot cross providers and fails explicitly instead of
silently dropping context. Live switching was verified with GPT-6.1 Sol and DeepSeek
V4.1 Flash. The remaining sections describe the legacy single-provider mode.

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
./scripts/switch.sh on    # selects the bridge without restarting the app
./scripts/switch.sh off   # restores the original model selection; keeps the provider
./scripts/switch.sh repair # restores a missing provider without changing selection
```

If settings do not refresh, reopen the app after active work finishes. Switching never
restarts app-server or quits the app. Each change creates a unique local backup.
These settings apply to new chats. Existing chats retain their provider even when
the menu bar shows GPT. Changing only their model can send a native GPT model to OpenCode.
Use `python3 scripts/recover_thread.py <thread-id> --model gpt-6.1-sol` after
switching off to fork the history into a native OpenAI chat. The original stays intact;
no inference request is made. The recovered chat is named `通常Codexで再開: …`.
Legacy `home-runner` menu apps must have their `scripts/bridge-switch.sh` entry point
replaced with this repo's `scripts/legacy-switch.sh` to use the updated switch logic.
Remote "open in another app" ownership conflicts require checking other clients
and server connections; keeping the provider does not fix remote ownership routing.

## Requirements

- Node.js 20+
- Python 3.11+ for configuration switching
- Codex CLI 0.163+ (or the ChatGPT desktop app with Codex)
- An OpenCode Go subscription, logged in (or `OPENCODE_API_KEY`)

## Not supported

- Native Codex `computer_use` tool (gated to OpenAI-authenticated providers);
  use the bundled `cua_repl` MCP instead
- In-app cost display (Codex computes it from OpenAI's price table)
- Built-in tools such as `web_search`

## License

MIT
