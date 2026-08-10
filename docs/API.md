# API — инструкция по использованию

Прокси отдаёт OpenAI-совместимый API. Продакшн-деплой: **2 воркера × 7 аккаунтов**
(порты `3264` и `3265`). Любой из них можно использовать как точку входа; при
желании повесьте оба за один reverse-proxy/балансировщик.

```
Базовый URL: http://127.0.0.1:3264/api      (воркер 0)
             http://127.0.0.1:3265/api      (воркер 1)
```

## Авторизация

- По умолчанию (localhost) — **без ключа**.
- Если включён `REQUIRE_API_KEYS=1` (обязательно для `HOST=0.0.0.0`) — передавайте
  ключ из `src/Authorization.txt`:
  ```bash
  curl -H 'Authorization: Bearer <ключ из Authorization.txt>' ...
  ```

## Чат — простой запрос

```bash
curl http://127.0.0.1:3264/api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"Привет!"}]}'
```

Ответ (не-stream):

```json
{
  "id": "...",
  "object": "chat.completion",
  "model": "qwen3.8-max",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "x_qwen_chat_id": "380f...",          // id чата — сохраните для продолжения
  "x_qwen_parent_id": "9b1e..."         // parent — для цепочки сообщений
}
```

## Стриминг

```bash
curl -N http://127.0.0.1:3264/api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"Напиши 3 факта о котах"}],"stream":true}'
```

Ответ — SSE: строки `data: {json chunk}` до `data: [DONE]`.

## Продолжение диалога (контекст)

Два способа:

1. **Передавать `chatId` (+ `parentId`)** из ответа:
   ```bash
   curl http://127.0.0.1:3264/api/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"qwen3.8-max","chatId":"380f...","parentId":"9b1e...","messages":[{"role":"user","content":"А ещё?"}]}'
   ```
2. **Сессия (cookie)**: v1-эндпоинт сам сохраняет chatId для сессии клиента.
   Если curl хранит cookie (`-c jar -b jar`), следующий запрос без `chatId`
   продолжит тот же диалог.

Альтернативный эндпоинт `POST /api/chat` (внутренний формат):

```bash
curl http://127.0.0.1:3264/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Привет!","model":"qwen3.8-max","chatId":"...","parentId":"..."}'
```

## Другие эндпоинты

| Метод и путь | Назначение |
|---|---|
| `GET /api/health` | Статус сервера, счётчики аккаунтов (ok, available, waiting) |
| `GET /api/status` | Статус авторизации и список аккаунтов |
| `GET /api/models` | Список моделей (OpenAI-формат) |
| `POST /api/chats` | Создать чат |
| `POST /api/chat` | Сообщение (`message`, `model`, `chatId`, `parentId`) |
| `POST /api/chat/completions` | OpenAI-совместимый чат (создаёт чат, отдаёт `chatId`/`parentId`) |
| `POST /api/v1/chat/completions` | OpenAI v1-стиль (`messages`, `stream`, `chatId`/`chat_id` в теле) |
| `GET/POST /api/chats/:chatId/history` | История чата |
| `POST /api/files/upload` | Загрузка файла |
| `POST /api/images/generations` | Генерация изображения (`prompt`, `model`, `n`, `size`) |
| `POST /api/videos/generations` | Генерация видео (возвращает `task_id`) |
| `GET /api/tasks/status/:taskId` | Прогресс видео-задачи |
| `GET /api/images/models`, `GET /api/videos/models` | Модели генерации |

## Обработка ошибок

- **429** — «Все токены заблокированы по лимиту»: аккаунты в лимите (25 операций/час
  на аккаунт). Подождите или добавьте аккаунты. Обычно это значит, что нагрузка выше
  расчётной: `аккаунты × 25` операций/час (~350/час на 14 аккаунтов).
- **401** — невалидный ключ/аккаунт: проверьте `Authorization` и авторизацию аккаунтов
  (`npm run auth -- --add`).
- **503 / verification** — требуется ручная верификация Qwen (интерактивный запуск).
- **500 «Unexpected non-SSE»** — редкий WAF-троттл; прокси сам пытается решить
  челлендж и повторить — повторите запрос, если клиент всё же увидел ошибку.

Прокси сам: выбирает аккаунт (round-robin + привязка чата к аккаунту), ротирует при
429/401, паркует перегруженные аккаунты (лимитер 25 оп/час) и автоматически решает
x5sec-слайдер (авто-солв), когда WAF челленджит.

## Модели

Полный список — `GET /api/models`. Популярные: `qwen3.8-max`, `qwen3.7-max`,
`qwen3.7-plus`, `qwen3.5-plus`, `qwen3.5-flash`, `qwen-turbo`.
