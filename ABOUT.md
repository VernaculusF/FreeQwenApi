# About FreeQwenApi

FreeQwenApi is a self-hosted OpenAI-compatible API proxy for the free
[Qwen Chat](https://chat.qwen.ai) web service. Instead of requiring a paid
DashScope/Model Studio key, it drives Qwen Chat through a real browser
(Puppeteer Stealth), so the account's free quota is served through a standard
OpenAI-shaped HTTP API.

## Why

- No paid API key required: works with regular Qwen Chat accounts.
- Multiple accounts behind one endpoint: round-robin rotation, automatic
  failover on 401/429, and per-chat account affinity.
- WAF-friendly: requests are made from an authenticated browser context with
  real session cookies, not from bare Node fetch.
- Agent-ready: OpenAI `tools`/tool-calling is emulated through prompt folding,
  so coding agents (opencode, Hermes, Claude Code, Codex, LiteLLM, Open WebUI)
  can use Qwen as a drop-in backend.

## How it works

```
client (OpenAI format)  →  FreeQwenApi (Express)  →  headless Chromium
                                                       │
                                    page.evaluate(fetch) to chat.qwen.ai
                                                       │
                                                  Qwen Chat account
```

1. The proxy keeps one headless Chromium per instance, preloaded with the
   session cookies of every saved account.
2. Each chat request picks an account (round-robin over valid tokens, with
   affinity so a conversation stays on the account that created it).
3. The completion request is executed from inside the browser page
   (`same-origin` fetch), which passes the Qwen WAF.
4. The response is translated back to the OpenAI chat completion format,
   including SSE streaming and tool-call emulation.

Accounts are added once through an interactive login (`npm run auth -- --add`);
their JWT and session cookies are stored under `session/` (never committed).

## Key properties

- **OpenAI-compatible**: `POST /api/chat/completions`, `GET /api/models`,
  `GET /api/status`, plus a native `POST /api/chat` with `chatId`/`parentId`.
- **Account rotation & failover**: on 429 the account is parked for
  `RATE_LIMIT_DEFAULT_HOURS` (default 1h) and the request retries on the next
  account; on 401 the account is marked invalid.
- **Multi-instance**: any number of worker processes with automatic account
  distribution (`npm run workers -- --workers N`).
- **Streaming**: SSE chunks with local pacing; short answers arrive as one
  burst, long ones stream token-by-token.
- **Docker**: compose file included; runs headless with `NON_INTERACTIVE=1`.

## Repository layout

```
src/
  api/            routes, chat execution, token manager, account affinity,
                  health checks, ping/error classification
  browser/        Puppeteer Stealth browser init, session save, auth flows
  utils/          operation guard, token import
  logger/         file-based logging
scripts/          auth CLI, worker launcher, smoke tests
docs/             OPERATION_GUIDE.md and integration notes
tests/            node:test suites
```

## Limits and caveats

- The free chat has a soft, undocumented limit (~100 messages/day per account
  in practice). Add more accounts to scale.
- Qwen's WAF may challenge automation; the proxy minimizes this by using
  browser context with real cookies, but a captcha can still appear.
- The proxy emulates tool calling via prompt folding, so tool-call fidelity is
  best-effort and depends on the model.

See [docs/OPERATION_GUIDE.md](docs/OPERATION_GUIDE.md) for setup, configuration,
multi-worker operation, and troubleshooting.
