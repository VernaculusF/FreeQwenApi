// qwenPing.js — единый модуль лёгкого ping Qwen и классификации ответов.
//
// Консолидирует:
//   - buildPingRequest()         — чистая сборка запроса ping: по умолчанию
//                                  list_chats (read-only GET списка чатов —
//                                  реальная форма трафика web-клиента, проходит
//                                  WAF и ничего не создаёт); create_chat и
//                                  legacy completions — за флагом QWEN_PING_MODE;
//   - pingQwenToken()            — лёгкий запрос в Qwen Chat из браузерного
//                                  контекста;
//   - classifyQwenError()        — единая классификация 401/429 (используется
//                                  в chat.js для ответов на chat-запросы);
//   - classifyPingResult()       — маппинг сырого результата ping в статус;
//   - pingQwenTokenWithRetry()   — единая политика retry: повтор только при
//                                  транзиентной ошибке (ERROR), UNAUTHORIZED и
//                                  RATELIMIT финальны и не ретраятся;
//   - buildQwenRequestHeaders()  — заголовки Qwen-запросов.
//
// ВАЖНО: модуль НЕ импортирует chat.js — chat.js импортирует отсюда, поэтому
// цикл chat.js ↔ qwenPing.js невозможен.

import crypto from 'crypto';
import { getBrowserContext, getPageFromContext, isBrowserVisibleMode } from '../browser/browser.js';
import { withOperationGuard } from '../utils/operationGuard.js';
import { isWafHtmlBlock } from '../utils/verificationMarkers.js';
import { logWarn, logError } from '../logger/index.js';
import {
    CHAT_PAGE_URL, CHAT_API_URL, CREATE_CHAT_URL, CHAT_LIST_URL, DEFAULT_MODEL, PAGE_EVALUATE_TIMEOUT,
    QWEN_PING_MODE, AUTH_STATUS_RETRY_COUNT, AUTH_STATUS_RETRY_DELAY_MS
} from '../config.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Заголовки Qwen-запросов ────────────────────────────────────────────────

function asciiTimezone(date = new Date()) {
    return date.toString().replace(/[\u0080-\uFFFF]/g, '');
}

export function buildQwenRequestHeaders(token, requestIdFactory = crypto.randomUUID) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Timezone': asciiTimezone(),
        'Version': process.env.QWEN_WEB_VERSION || '0.2.63',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': requestIdFactory(),
        'source': 'web'
    };

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    return headers;
}

// ─── Классификация ошибок/результатов ───────────────────────────────────────

/**
 * Единая классификация ответа Qwen (chat-запросы и ping).
 *
 * @param {object} params
 * @param {number} [params.status]         — HTTP-статус (0, если неизвестен)
 * @param {string|null} [params.errorBody] — тело ошибки (может содержать "Unauthorized"/"RateLimited")
 * @param {string|string[]} [params.code]  — код(ы) ошибки из структурированного ответа (data.code)
 * @returns {{ kind: 'unauthorized'|'ratelimit'|'transient'|'other', effectiveStatus: number }}
 */
export function classifyQwenError({ status = 0, errorBody = null, code = null } = {}) {
    const body = typeof errorBody === 'string' ? errorBody : '';
    const isUnauthorized = status === 401 || /Unauthorized|Token has expired/i.test(body);
    const codes = Array.isArray(code) ? code : [code];
    const hasRateLimitCode = codes.some(c => c === 'RateLimited');
    const isRateLimited = status === 429 || body.includes('RateLimited') || hasRateLimitCode;

    let kind = 'other';
    if (isUnauthorized) kind = 'unauthorized';
    else if (isRateLimited) kind = 'ratelimit';
    else if (status >= 500 && status < 600) kind = 'transient';

    return { kind, effectiveStatus: isUnauthorized ? 401 : isRateLimited ? 429 : status };
}

/**
 * Маппинг сырого результата pingQwenToken в нормализованный статус.
 * Используется authStatusCheck (как normalizeLiveStatus) и tokenHealthCheck.
 */
export function classifyPingResult(raw) {
    if (raw === 'OK') return { status: 'ok', authenticated: true, rateLimited: false };
    if (raw === 'UNAUTHORIZED') return { status: 'unauthorized', authenticated: false, rateLimited: false };
    if (raw === 'RATELIMIT') return { status: 'ratelimit', authenticated: true, rateLimited: true };
    return { status: 'error', authenticated: null, rateLimited: false };
}

/**
 * Классификация ответа ping по статусу И телу (чистая функция для тестов).
 *
 * Ключевой случай: анти-бот WAF Alibaba отвечает HTTP 200 с HTML-страницей
 * капчи (_____tmd_____/punish/x5sec) — это НЕ здоровый токен, а транзиентный
 * сбой, при котором токен трогать нельзя (иначе healthcheck «сожжёт» аккаунты
 * из-за WAF, а не из-за реального 401). Также ловим 200-е с JSON-телом ошибки
 * («Unauthorized»/«RateLimited» внутри успешного статуса).
 */
export function classifyPingResponse({ ok = false, status = 0, body = null } = {}) {
    const bodyText = typeof body === 'string' ? body : '';
    if (isWafHtmlBlock(bodyText)) return 'ERROR';

    // 200-е с JSON-телом: явный `success` важнее текстовых эвристик и проверяется
    // ДО classifyQwenError — иначе слово «Unauthorized» в заголовке чата из
    // списка (success:true) ошибочно приняло бы токен за недействительный.
    //   success:true  — определённо здоровый токен (список чатов, созданный чат);
    //   success:false — сбой запроса: «unauthorized»/истёкшая сессия → UNAUTHORIZED,
    //                   RateLimited → RATELIMIT, иначе ERROR. Именно так Qwen
    //                   отвечает невалидному токену на GET /api/v2/chats.
    if (status === 200 && bodyText.startsWith('{')) {
        try {
            const parsed = JSON.parse(bodyText);
            if (parsed && parsed.success === true) return 'OK';
            if (parsed && parsed.success === false) {
                const { kind } = classifyQwenError({ status, errorBody: bodyText });
                if (kind === 'unauthorized') return 'UNAUTHORIZED';
                if (kind === 'ratelimit') return 'RATELIMIT';
                return 'ERROR';
            }
        } catch { /* не JSON — дальше по обычным правилам */ }
    }

    const { kind } = classifyQwenError({ status, errorBody: bodyText });
    if (kind === 'unauthorized') return 'UNAUTHORIZED';
    if (kind === 'ratelimit') return 'RATELIMIT';

    if (status === 401 || status === 403) return 'UNAUTHORIZED';
    if (status === 429) return 'RATELIMIT';

    if (ok || status === 400) return 'OK';
    return 'ERROR';
}

// ─── Форма запроса ping ────────────────────────────────────────────────────

/**
 * Собирает запрос ping токена (чистая функция для тестов).
 *
 * Форма по умолчанию — list_chats: GET /api/v2/chats/?page=1&exclude_project=true,
 * ровно тот read-only запрос, которым web-клиент Qwen загружает список чатов
 * при открытии страницы. Реальная форма трафика — гарантированно проходит
 * анти-бот (проверено живьём) и ничего не создаёт: ни чатов, ни расхода квоты.
 * Невалидному токену Qwen отвечает 200 с success:false и «unauthorized» —
 * классифицируется как UNAUTHORIZED.
 *
 * create_chat — POST /api/v2/chats/new (форма, тоже проходящая WAF, но создающая
 * пустой чат «freeqwen-ping» на каждую проверку); сохраняется за флагом
 * QWEN_PING_MODE=create_chat как запасной вариант.
 *
 * Legacy-форма completions (прямой POST в /chat/completions без chat_id)
 * сохраняется за флагом QWEN_PING_MODE=completions для отладки/отката.
 */
export function buildPingRequest(token, { mode = QWEN_PING_MODE, now = Date.now } = {}) {
    const headers = buildQwenRequestHeaders(token);
    const credentials = 'same-origin';

    if (mode === 'completions') {
        return {
            method: 'POST',
            apiUrl: CHAT_API_URL,
            headers,
            credentials,
            payload: { chat_type: 't2t', messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }], model: DEFAULT_MODEL, stream: false }
        };
    }

    if (mode === 'create_chat') {
        return {
            method: 'POST',
            apiUrl: CREATE_CHAT_URL,
            headers,
            credentials,
            payload: {
                title: 'freeqwen-ping',
                models: [DEFAULT_MODEL],
                chat_mode: 'normal',
                chat_type: 't2t',
                timestamp: now()
            }
        };
    }

    return {
        method: 'GET',
        apiUrl: CHAT_LIST_URL,
        headers,
        credentials,
        payload: null
    };
}

// ─── Ping токена ────────────────────────────────────────────────────────────

/**
 * Лёгкий ping токена в Qwen Chat из браузерного контекста.
 * Возвращает 'OK' | 'UNAUTHORIZED' | 'RATELIMIT' | 'ERROR'.
 */
export async function pingQwenToken(token) {
    const browserContext = getBrowserContext();
    if (!browserContext) return 'ERROR';

    let page;
    let shouldClosePage = false;
    try {
        if (isBrowserVisibleMode() && typeof browserContext.evaluate === 'function') {
            // Ручная авторизация/верификация (видимый браузер): НЕ создаём новую
            // вкладку — пользователь видит открытие/закрытие, а WAF считает такое
            // поведение подозрительным. Пингуем прямо из базовой страницы, которая
            // уже находится на chat.qwen.ai: same-origin fetch без навигации и без
            // вмешательства в процесс логина.
            page = browserContext;
        } else {
            page = await getPageFromContext(browserContext);
            shouldClosePage = page !== browserContext;
            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });
        }

        const requestBody = buildPingRequest(token);

        const result = await withOperationGuard(
            page.evaluate(async (data) => {
                try {
                    const res = await fetch(data.apiUrl, {
                        method: data.method || 'POST',
                        credentials: data.credentials,
                        headers: data.headers,
                        body: data.payload ? JSON.stringify(data.payload) : undefined
                    });
                    // Захватываем начало тела: без него 200-я HTML-капча WAF
                    // неотличима от успешной проверки токена.
                    const body = await res.text();
                    return { ok: res.ok, status: res.status, body: body.slice(0, 2000) };
                } catch (e) {
                    return { ok: false, status: 0, error: e.toString() };
                }
            }, requestBody),
            { timeoutMs: PAGE_EVALUATE_TIMEOUT, label: 'Проверка токена' }
        );

        const raw = classifyPingResponse(result);
        const bodyText = typeof result?.body === 'string' ? result.body : '';
        if (raw === 'ERROR' && isWafHtmlBlock(bodyText)) {
            logWarn(`pingQwenToken: Qwen вернул анти-бот страницу (WAF), HTTP ${result?.status ?? '?'}. Токен не проверен.`);
        }
        return raw;
    } catch (e) {
        logError('pingQwenToken error', e);
        return 'ERROR';
    } finally {
        if (page) {
            try { if (shouldClosePage) await page.close(); } catch { }
        }
    }
}

/**
 * Единая политика retry для ping: повторяется ТОЛЬКО транзиентная ошибка
 * (ERROR — сеть/браузер). UNAUTHORIZED и RATELIMIT финальны и не ретраятся,
 * чтобы не «сжигать» запросы к Qwen на заведомо необратимых статусах.
 * Возвращает сырой статус: 'OK' | 'UNAUTHORIZED' | 'RATELIMIT' | 'ERROR'.
 */
export async function pingQwenTokenWithRetry(token, {
    pingFn = pingQwenToken,
    retryCount = AUTH_STATUS_RETRY_COUNT,
    retryDelayMs = AUTH_STATUS_RETRY_DELAY_MS
} = {}) {
    let raw = 'ERROR';
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
            raw = await pingFn(token);
        } catch (e) {
            logWarn(`Проверка токена: ошибка попытки ${attempt + 1}: ${e.message}`);
            raw = 'ERROR';
        }
        if (raw !== 'ERROR') break;
        if (attempt < retryCount && retryDelayMs > 0) await delay(retryDelayMs);
    }
    return raw;
}
