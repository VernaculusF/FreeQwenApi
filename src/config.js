// config.js — Единый источник конфигурации проекта.
// Все значения читаются из env-переменных с фоллбэками на дефолты.

import fs from 'fs';
import path from 'path';

function loadDotEnv(filePath = path.join(process.cwd(), '.env')) {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const equalsIndex = line.indexOf('=');
        if (equalsIndex === -1) continue;

        const key = line.slice(0, equalsIndex).trim();
        if (!key || process.env[key] !== undefined) continue;

        let value = line.slice(equalsIndex + 1).trim();
        const quoted =
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"));
        if (quoted) {
            value = value.slice(1, -1);
        } else {
            const hashIndex = value.indexOf('#');
            if (hashIndex !== -1) value = value.slice(0, hashIndex).trim();
        }

        process.env[key] = value;
    }
}

loadDotEnv();

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

// Число >= 0 из env (0 допустим, например «отключить интервал»);
// иначе — fallback.
function nonNegativeNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ─── API URLs ────────────────────────────────────────────────────────────────
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || 'https://chat.qwen.ai';

export const CHAT_API_URL = process.env.CHAT_API_URL || `${QWEN_BASE_URL}/api/v2/chat/completions`;
export const CREATE_CHAT_URL = process.env.CREATE_CHAT_URL || `${QWEN_BASE_URL}/api/v2/chats/new`;
// Read-only запрос списка чатов — та же форма, что web-клиент Qwen делает при
// открытии страницы (реальный трафик, проходит анти-бот). Используется ping'ом
// токена: ничего не создаёт и квоту сообщений не расходует.
export const CHAT_LIST_URL = process.env.CHAT_LIST_URL || `${QWEN_BASE_URL}/api/v2/chats/?page=1&exclude_project=true`;
export const CHAT_PAGE_URL = process.env.CHAT_PAGE_URL || `${QWEN_BASE_URL}/`;
export const TASK_STATUS_URL = process.env.TASK_STATUS_URL || `${QWEN_BASE_URL}/api/v1/tasks/status`;
export const STS_TOKEN_API_URL = process.env.STS_TOKEN_API_URL || `${QWEN_BASE_URL}/api/v1/files/getstsToken`;
export const AUTH_SIGNIN_URL = process.env.AUTH_SIGNIN_URL || `${QWEN_BASE_URL}/auth?action=signin`;
export const OSS_SDK_URL = process.env.OSS_SDK_URL || 'https://gosspublic.alicdn.com/aliyun-oss-sdk-6.20.0.min.js';

// ─── Форма ping токена ───────────────────────────────────────────────────────
// list_chats (по умолчанию) — GET /api/v2/chats/?page=1&exclude_project=true:
// read-only запрос, которым сам web-клиент Qwen загружает список чатов при
// открытии страницы. Реальная форма трафика — проходит анти-бот (проверено
// живьём) и ничего не создаёт: ни чатов, ни расхода квоты.
// create_chat — POST /api/v2/chats/new: тоже проходит WAF, но создаёт пустой
// чат «freeqwen-ping» на каждую проверку (запасная форма, если list_chats
// вдруг заблокируют).
// completions — legacy: прямой POST в /chat/completions без chat_id. Против
// текущего WAF виснет/возвращает HTML-капчу; только для отладки/отката.
// Любое другое значение нормализуется в list_chats.
export const QWEN_PING_MODE = ['list_chats', 'create_chat', 'completions'].includes(process.env.QWEN_PING_MODE)
    ? process.env.QWEN_PING_MODE
    : 'list_chats';

// ─── Таймауты (мс) ──────────────────────────────────────────────────────────
export const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT) || 120_000;
export const PROTOCOL_TIMEOUT = Number(process.env.PROTOCOL_TIMEOUT) || 300_000;
export const AUTH_TIMEOUT = Number(process.env.AUTH_TIMEOUT) || 120_000;
export const NAVIGATION_TIMEOUT = Number(process.env.NAVIGATION_TIMEOUT) || 60_000;
export const RETRY_DELAY = Number(process.env.RETRY_DELAY) || 2_000;
export const STREAMING_CHUNK_DELAY = Number(process.env.STREAMING_CHUNK_DELAY) || 20;
// Максимальное время выполнения одного page.evaluate(fetch) в браузере.
// Защита от «вечных» запросов и зомби-задач при обрыве клиента.
export const PAGE_EVALUATE_TIMEOUT = Number(process.env.PAGE_EVALUATE_TIMEOUT) || PROTOCOL_TIMEOUT;
// Таймаут проверки «живости» страницы из пула.
export const POOL_PROBE_TIMEOUT = Number(process.env.POOL_PROBE_TIMEOUT) || 10_000;

// ─── Watchdog браузера ──────────────────────────────────────────────────────
export const BROWSER_WATCHDOG_INTERVAL = Number(process.env.BROWSER_WATCHDOG_INTERVAL) || 30_000;
export const BROWSER_WATCHDOG_PROBE_TIMEOUT = Number(process.env.BROWSER_WATCHDOG_PROBE_TIMEOUT) || 5_000;
export const BROWSER_WATCHDOG_MAX_BACKOFF = Number(process.env.BROWSER_WATCHDOG_MAX_BACKOFF) || 600_000;

// ─── Лимиты ─────────────────────────────────────────────────────────────────
export const PAGE_POOL_SIZE = Number(process.env.PAGE_POOL_SIZE) || 3;
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024; // 10 MB
export const MAX_HISTORY_LENGTH = Number(process.env.MAX_HISTORY_LENGTH) || 100;
export const MAX_RETRY_COUNT = Number(process.env.MAX_RETRY_COUNT) || 3;
// Сколько часов аккаунт уходит в resetAt, когда Qwen отвечает 429/RateLimited
// без указания конкретного времени сброса (поле `num`). Значение из ответа
// Qwen имеет приоритет над этим дефолтом.
export const RATE_LIMIT_DEFAULT_HOURS = Number(process.env.RATE_LIMIT_DEFAULT_HOURS) || 1;
export const TASK_POLL_MAX_ATTEMPTS = Number(process.env.TASK_POLL_MAX_ATTEMPTS) || 90;
export const TASK_POLL_INTERVAL = Number(process.env.TASK_POLL_INTERVAL) || 2_000;

// ─── Бан-висение Qwen (замерено стресс-тестами) ─────────────────────────────
// Qwen НЕ возвращает 429: после ~25-35 операций (создание чата + сообщения)
// на аккаунт в скользящем окне он начинает ДЕРЖАТЬ запросы без ответа
// (разбан ~30-45 мин, когда окно сдвигается). Прокси не видит этот бан по
// ответу, поэтому:
//  1) проактивно лимитируем операции на аккаунт (QWEN_OPS_PER_HOUR) — паркуем
//     аккаунт заранее, не давая дойти до бана;
//  2) реактивно паркуем аккаунт, если create-chat/запрос не ответил за
//     QWEN_BAN_DETECT_MS (нормальный create-chat — <1с, так что долгий ответ
//     почти наверняка бан-висение) — вместо 300-секундного зависания ротация
//     переключается на другой аккаунт и запрос падает быстро с 429.
export const QWEN_OPS_PER_HOUR = Number(process.env.QWEN_OPS_PER_HOUR) || 25;
export const QWEN_OPS_WINDOW_MS = Number(process.env.QWEN_OPS_WINDOW_MS) || 3600_000;
export const QWEN_OPS_BAN_HOURS = Number(process.env.QWEN_OPS_BAN_HOURS) || 1;
export const QWEN_BAN_DETECT_MS = Number(process.env.QWEN_BAN_DETECT_MS) || 20_000;
// Ретрай после солва висит почти наверняка из-за ре-челленджа WAF. Ждать его
// полные QWEN_BAN_DETECT_MS = 20с слишком долго для интерактивных клиентов:
// recovery (проба WAF + повторный солв) запускается раньше, сам запрос при
// этом не прерывается — успеет ответить — лишний солв просто пропадёт.
export const QWEN_WAF_RECOVERY_MS = Number(process.env.QWEN_WAF_RECOVERY_MS) || 12_000;
// Пауза между проверками аккаунтов в scripts/probe_accounts.js (cool-down).
// Массовая проверка с одного IP быстрее провоцирует WAF-челлендж; разводка
// по времени снижает число PUNISH из-за самого прогона.
export const QWEN_PROBE_DELAY_MS = nonNegativeNumber(process.env.QWEN_PROBE_DELAY_MS, 2_000);

// ─── Пути (относительно корня проекта) ───────────────────────────────────────
export const SESSION_DIR = process.env.SESSION_DIR || 'session';
export const ACCOUNTS_DIR = 'accounts';
export const UPLOADS_DIR = process.env.UPLOADS_DIR || 'uploads';
export const LOGS_DIR = process.env.LOGS_DIR || 'logs';

// ─── Многоинстансность / воркеры ────────────────────────────────────────────
// Подмножество аккаунтов для ЭТОГО инстанса:
//   'k/n'      — k-й из n воркеров: аккаунты распределяются автоматически
//                (детерминированно по FNV-1a от id аккаунта);
//   'id1,id2'  — явный список id аккаунтов;
//   пусто      — все аккаунты (обычный одиночный запуск).
// Управление воркерами удобнее через `npm run workers -- --workers N`.
export const ACCOUNT_SUBSET = process.env.ACCOUNT_SUBSET || '';

// ─── Браузер ─────────────────────────────────────────────────────────────────
export const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH) || 1920;
export const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT) || 1080;
export const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── Сервер ──────────────────────────────────────────────────────────────────
export const PORT = Number(process.env.PORT) || 3264;
// Неинтерактивный режим (Docker/systemd/агенты): запрещает блокирующие
// stdin-промпты (верификация/авторизация) и перезапуск браузера в видимом режиме.
export const NON_INTERACTIVE = toBoolean(process.env.NON_INTERACTIVE);
export const HOST = process.env.HOST || '127.0.0.1';
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen3.8-max';
export const ALLOW_UNSCOPED_SESSION_CHAT_RESTORE = toBoolean(process.env.ALLOW_UNSCOPED_SESSION_CHAT_RESTORE);

// ─── Безопасность ────────────────────────────────────────────────────────────
// Если включено — пустой/отсутствующий src/Authorization.txt считается ошибкой:
// сервер не стартует (fail-fast) и отвергает запросы без валидного ключа.
// По умолчанию выключено (обратная совместимость: пустой файл = без авторизации).
export const REQUIRE_API_KEYS = toBoolean(process.env.REQUIRE_API_KEYS);

// ─── Токен-хелсчек Qwen аккаунтов ────────────────────────────────────────────
// Интервал проверки токенов по расписанию, мс. 0 — отключить.
export const TOKEN_HEALTH_CHECK_INTERVAL_MS = nonNegativeNumber(process.env.TOKEN_HEALTH_CHECK_INTERVAL_MS, 3_600_000);
// Задержка перед первым прогоном после старта сервера, мс.
export const TOKEN_HEALTH_CHECK_INITIAL_DELAY_MS = nonNegativeNumber(process.env.TOKEN_HEALTH_CHECK_INITIAL_DELAY_MS, 60_000);
// Пауза между проверками отдельных аккаунтов в одном прогоне, мс.
// Защита от анти-бот Qwen при массовой проверке.
export const TOKEN_HEALTH_CHECK_DELAY_MS = nonNegativeNumber(process.env.TOKEN_HEALTH_CHECK_DELAY_MS, 2_000);

// ─── Фоновая очистка (TTL) ───────────────────────────────────────────────────
// TTL файлов истории чатов (session/history/*.json), мс. 0 — не очищать.
export const HISTORY_TTL_MS = nonNegativeNumber(process.env.HISTORY_TTL_MS, 30 * 24 * 3600 * 1000);
// TTL временных файлов uploads/, мс. 0 — не очищать.
export const UPLOADS_TTL_MS = nonNegativeNumber(process.env.UPLOADS_TTL_MS, 24 * 3600 * 1000);
// Интервал прогона фоновой очистки, мс. 0 — отключить очистку целиком.
export const CLEANUP_INTERVAL_MS = nonNegativeNumber(process.env.CLEANUP_INTERVAL_MS, 6 * 3600 * 1000);
// Задержка перед первым прогоном очистки после старта сервера, мс.
export const CLEANUP_INITIAL_DELAY_MS = nonNegativeNumber(process.env.CLEANUP_INITIAL_DELAY_MS, 60_000);

// ─── Живая проверка авторизации (GET /api/status) ───────────────────────────
// TTL кэша результата проверки токена Qwen, мс. 0 — всегда проверять «живьём»
// (не рекомендуется: каждый запрос /api/status бьёт в Qwen).
export const AUTH_STATUS_CACHE_TTL_MS = nonNegativeNumber(process.env.AUTH_STATUS_CACHE_TTL_MS, 60_000);
// Дополнительные попытки при транзиентной ошибке (ERROR), сверх первой.
export const AUTH_STATUS_RETRY_COUNT = nonNegativeNumber(process.env.AUTH_STATUS_RETRY_COUNT, 1);
// Пауза между попытками retry, мс.
export const AUTH_STATUS_RETRY_DELAY_MS = nonNegativeNumber(process.env.AUTH_STATUS_RETRY_DELAY_MS, 1_000);
// TTL кэш-флага авторизации браузера (isAuthenticated), мс. После истечения
// getAuthenticationStatus() возвращает false и сессия перепроверяется ping'ом
// при следующем обращении. 0 — отключено (флаг живёт, пока не сброшен явно).
export const BROWSER_AUTH_TTL_MS = nonNegativeNumber(process.env.BROWSER_AUTH_TTL_MS, 12 * 3600 * 1000);
// Негативный кэш checkAuthentication: после неудачного прогона (нет токена /
// 401 / транзиентная ошибка) браузерная проверка повторяется не чаще раза в
// это окно, мс — чтобы /api/status без сессии не гонял page.goto на каждый
// запрос. 0 — отключено (проверять каждый раз).
export const AUTH_CHECK_NEGATIVE_CACHE_MS = nonNegativeNumber(process.env.AUTH_CHECK_NEGATIVE_CACHE_MS, 30_000);

// ─── Логирование ─────────────────────────────────────────────────────────────
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
export const LOG_MAX_SIZE = Number(process.env.LOG_MAX_SIZE) || 5_242_880; // 5 MB
export const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES) || 5;
