# FreeQwenApi

Local Node.js API proxy for Qwen Chat based on browser automation. It exposes OpenAI-compatible endpoints for tools that cannot connect directly to the Qwen Chat web interface.

This is not an official Alibaba or Qwen API and does not run a local model. It depends on Qwen Chat's internal web interfaces, which may change without notice.

## Возможности

- OpenAI-compatible chat completions with streaming support
- Model listing and model metadata synchronization
- File upload and image analysis
- Image and video generation through Qwen Chat
- Multiple account sessions with account rotation
- Open WebUI, LiteLLM, and OpenAI SDK integration examples
- Health, status, and smoke-test endpoints

## Стек

- Node.js with ES modules
- Express
- Puppeteer with stealth plugin
- Axios and node-fetch
- Winston and Morgan
- Docker and Docker Compose

## Быстрый старт

Node.js 18 or newer is recommended. Install dependencies and create a Qwen Chat session:

```bash
git clone https://github.com/VernaculusF/FreeQwenApi.git
cd FreeQwenApi
npm install
npm run auth
npm run models:sync
SKIP_ACCOUNT_MENU=true npm start
```

The authorization command opens Chromium. Sign in to Qwen Chat and return to the terminal after the session is saved. Session data, tokens, browser profiles, `.env`, and `Authorization.txt` must not be committed.

The API is available at `http://localhost:3264/api`. Check the running service from another terminal:

```bash
curl http://localhost:3264/api/health
curl http://localhost:3264/api/models
npm run smoke
```

Send a chat request:

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [{"role": "user", "content": "Explain this API briefly."}],
    "stream": false
  }'
```

For Docker, authorize an account locally before starting the container because the container has no interactive browser login:

```bash
npm run auth
docker compose up --build -d
```

Additional integration and media endpoint documentation is available in `docs/` and `IMAGE_VIDEO_GENERATION_GUIDE.md`.

## Структура проекта

- `index.js` — service entry point
- `src/api/` — API routes, chat, file, and media handlers
- `src/browser/` — browser automation and session management
- `src/logger/` — application logging
- `src/utils/` — account setup and utility functions
- `scripts/` — authorization, model synchronization, and smoke-test commands
- `examples/` — direct API, OpenAI SDK, Python, Hermes, and LiteLLM examples
- `docs/` — endpoint and integration documentation
- `session/` — local account data created at runtime and excluded from Git

## Лицензия

MIT
