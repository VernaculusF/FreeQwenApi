# FreeQwenApi Operation Guide

OpenAI-compatible proxy to the free Qwen Chat (`chat.qwen.ai`) through browser
emulation (Puppeteer Stealth). It manages multiple Qwen accounts and serves them
through one local API with account rotation and per-chat account affinity.

---

## 1. Quick start

```bash
npm install          # install dependencies
npm start            # start: menu → Enter (= 3 "Run proxy")
```

By default the server listens on `http://127.0.0.1:3264` (change with `PORT` /
`HOST` in `.env`).

On the first run without accounts the menu is shown. Add an account through menu
item 1 or directly (`npm run auth -- --add`), then start the proxy.

---

## 2. Account management

```bash
npm run auth -- --add       # add account (interactive browser login)
npm run auth -- --list      # list accounts and statuses
npm run auth -- --remove    # remove account
npm run auth -- --relogin   # re-login an account with an expired token
npm run auth -- --import <file>  # bulk token import (no browser)
npm run auth               # interactive management menu
```

### How `--add` works

1. A visible Chromium window opens on `chat.qwen.ai`.
2. Sign in (GitHub, etc.). If a captcha/slider appears, solve it slowly and
   "naturally".
3. As soon as the login is detected and the token is confirmed by a ping, the
   window closes automatically (usually 5-30 seconds after login). You can speed
   it up by pressing ENTER in the console.
4. The account is saved in `session/tokens.json`; the session cookies are saved
   in `session/accounts/<id>/cookies.json`.

> The token and cookies are the account's access credentials. Deleting
> `session/accounts/<id>` or `cookies.json` requires a fresh login.

### What is stored

```
session/
├── tokens.json                 # account registry (id + token + resetAt/invalid)
└── accounts/
    ├── acc_1786...1048/        # account token (token.txt)
    └── acc_1786...0931/        # session cookies (cookies.json) — from login
```

Note: cookies live in a separate directory (id is generated when the session is
saved). The proxy loads the cookies of **all** saved sessions into the headless
browser — this is required for the Qwen WAF to let API requests through.

---

## 3. Configuration (`.env`)

Copy `.env.example` to `.env` and adjust. Key variables:

| Variable | Default | Description |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3264` | Proxy address |
| `DEFAULT_MODEL` | `qwen3.8-max` | Model used when the client omits `model` |
| `NON_INTERACTIVE` | — | Skip menu; disable stdin prompts (systemd/Docker/agents) |
| `SKIP_ACCOUNT_MENU` | — | Skip the startup menu |
| `ACCOUNT_SUBSET` | — | Account share for this instance: `k/n` or `id1,id2` (see §5) |
| `REQUIRE_API_KEYS` | — | Require Bearer keys from `src/Authorization.txt` (required for `HOST=0.0.0.0`) |
| `RATE_LIMIT_DEFAULT_HOURS` | `1` | How many hours an account is parked (`resetAt`) on 429 without an explicit `num` in the response |
| `PAGE_POOL_SIZE` | `3` | Browser page pool size (higher = more throughput, higher anti-bot risk) |
| `TOKEN_HEALTH_CHECK_INTERVAL_MS` | `3600000` | Automatic token check interval (0 disables) |
| `QWEN_USE_NODE_FETCH` | `0` | `1` — send via Node fetch (faster errors, more captchas); `0` — browser (recommended) |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

The full list is in `.env.example`.

---

## 4. API

OpenAI-compatible endpoint: **`POST /api/chat/completions`**

```bash
curl http://127.0.0.1:3264/api/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"Hello!"}]}'
```

Other endpoints:

| Method and path | Purpose |
|---|---|
| `GET /api/status` | Auth status and account list |
| `GET /api/models` | Model list (OpenAI format) |
| `POST /api/chats` | Create a new chat |
| `POST /api/chat` | Send a message (with `chatId`/`parentId` for continuation) |
| `POST /api/chat/completions` | OpenAI-compatible chat (creates a chat on first request, returns `chatId`/`parentId`) |

Streaming: pass `"stream": true` — the response arrives as an SSE stream.

Request format for `POST /api/chat`:
```json
{ "message": "text", "model": "qwen3.8-max", "chatId": "...", "parentId": "..." }
```

### Account selection

The proxy picks the account itself: round-robin over valid accounts + affinity of
a chat to the account it was created on. On 429/401 the account is marked
(`resetAt`/`invalid`) and the request retries on another account.

---

## 5. Multiple instances and N workers

### Option A: manual, 2+ instances

```bash
PORT=3264 npm start   # in one terminal
PORT=3265 npm start   # in another terminal
```

Each instance is a separate process with its own headless browser. They share
`session/tokens.json` and use **all** accounts (an account can be used by both
instances at the same time).

### Option B: worker launcher with automatic account distribution (recommended)

```bash
npm run workers -- --workers 2              # 2 workers: ports 3264, 3265
npm run workers -- --workers 4 --base-port 8000   # 4 workers: 8000-8003
```

What the launcher (`scripts/workers.js`) does:

- reads `session/tokens.json` and **distributes accounts automatically** between
  workers (deterministically, by FNV-1a of the account id);
- each worker is a separate `node index.js` process on port `base-port + k` with
  account share `ACCOUNT_SUBSET=k/n`;
- empty shares (more workers than accounts) are not started;
- a crashed worker restarts automatically after 2 seconds;
- `Ctrl+C` stops all workers cleanly.

On startup the launcher prints the distribution table:

```
Workers: 2 | Accounts in registry: 14
  worker 0 — port 3264: 7 accounts  [acc_..., ...]
  worker 1 — port 3265: 7 accounts  [acc_..., ...]
```

Notes:

- The same account always lands in the same share; adding accounts does not
  reshuffle the already distributed ones.
- Accounts added via `npm run auth -- --add` while running are picked up by
  workers **without a restart** (the registry is read from disk).
- Each worker serves requests only with its own accounts; `invalid`/`resetAt`
  marks are written to the shared file and visible to all.

### Multi-instance limitations

- **Memory**: each worker runs its own Chromium (~200-500 MB).
- **Shared `session/tokens.json`**: simultaneous writes by two workers (e.g. 429
  marks) have a rare lost-update risk (read-modify-write). For production with
  several workers, move the registry to a DB or add file locking.
- **Shared cookies**: currently the cookies of all accounts are loaded into every
  worker's browser. For many different Qwen logins in one registry, bind cookies
  per account.

---

## 6. Qwen limits (reference)

### Free chat (chat.qwen.ai) — what the proxy uses

- No official numbers. In practice — **~100 messages/day per account** (soft
  limit; smaller models are nearly unlimited, top models hit it faster).
- On overflow or suspicious activity — anti-bot WAF/captcha:
  `FAIL_SYS_USER_VALIDATE`, "被挤爆啦,请稍后重试". This is **not** a chat limit
  but automation protection; fresh cookies/captcha clear it.
- 14 accounts ≈ ~1400 messages/day headroom via rotation.

### Paid API (Model Studio / DashScope) — for an official key

- `qwen3.8-max` / `qwen3.7-max`: **600 RPM / 1M TPM**.
- plus/flash: 15 000 RPM / 5M TPM; `qwen-turbo`: 600 RPM / 5M TPM.
- Limits are per account (summed across keys), recovery ~1 minute.
- Bursts are cut by RPS (RPM/60) even within the per-minute limit.
- Context: qwen3.8-max / qwen3.7-max — up to 1M tokens; qwen3-max — 262K;
  qwen-max — 32K.

---

## 7. Troubleshooting

### "Qwen returned an anti-bot page (WAF)" / FAIL_SYS_USER_VALIDATE

Requests are sent without session cookies (cookies deleted or not loaded).
Check:

```bash
ls session/accounts/*/cookies.json   # at least one file should exist
```

If there are no files, re-run authentication (`npm run auth -- --add`). The
proxy loads the cookies into the browser on startup (log line: "Loaded N session
cookies").

### "No accounts found"

`session/tokens.json` is empty or missing. Add an account:
`npm run auth -- --add`.

### Port in use (EADDRINUSE)

Another instance is already listening on this port. Use another one:
`PORT=3265 npm start`, or check the process: `ss -tlnp | grep 3264`.

### Everything answers 429 / accounts in "awaiting reset"

A rate limit fired (WAF or message limit). The account goes into `resetAt` for
`RATE_LIMIT_DEFAULT_HOURS` (default 1 hour) unless the response carries an
explicit reset time. Either wait, add more accounts, or change the IP (WAF may
block by IP).

### Browser restarts (Watchdog)

Automatic protection: if Chromium hangs or crashes, the worker restarts it in
headless mode. Check `logs/combined.log`.

### Headless browser does not start

Make sure Chromium/Chrome is installed. You can point to it explicitly:
`CHROME_PATH=/usr/bin/chromium npm start`.

---

## 8. Docker

```bash
docker compose up -d          # build and start
docker compose logs -f        # logs
```

In Docker the server runs in `NON_INTERACTIVE=1` (no menu) — accounts are added
on the host via `npm run auth -- --add`, and `session/` is mounted as a volume.

---

## 9. Security

- The proxy listens on `127.0.0.1` by default. If you expose it
  (`HOST=0.0.0.0`), **must** enable `REQUIRE_API_KEYS=1` and fill
  `src/Authorization.txt`.
- Never commit `.env` and `session/` (they contain tokens and cookies).
- Request body limit is 150 MB; file uploads are capped by `MAX_FILE_SIZE`
  (10 MB).
