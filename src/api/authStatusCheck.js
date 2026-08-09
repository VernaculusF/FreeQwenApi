// authStatusCheck.js — живая проверка авторизации Qwen (GET /api/status).
//
// КЭШИРУЕТ результат проверки токена на AUTH_STATUS_CACHE_TTL_MS, чтобы
// клиенты, опрашивающие /api/status, не били в Qwen на каждый запрос.
// Конкурентные запросы с одним токеном дедуплицируются (один прогон на всех).
// Сам ping и политика retry делегируются в единый qwenPing.js
// (pingQwenTokenWithRetry): повтор только при транзиентной ошибке,
// UNAUTHORIZED/RATELIMIT финальны.

import { pingQwenToken, pingQwenTokenWithRetry, classifyPingResult } from './qwenPing.js';
import { AUTH_STATUS_CACHE_TTL_MS, AUTH_STATUS_RETRY_COUNT, AUTH_STATUS_RETRY_DELAY_MS } from '../config.js';

const cache = new Map();    // token -> { result, checkedAt }
const inflight = new Map(); // token -> Promise

// Обратная совместимость имени для потребителей/тестов.
export { classifyPingResult as normalizeLiveStatus };

function pruneCache(ttlMs, now) {
    if (cache.size === 0) return;
    const keepUntil = now - Math.max(2 * ttlMs, 60_000);
    for (const [token, entry] of cache) {
        if (entry.checkedAt < keepUntil) cache.delete(token);
    }
}

/**
 * Живая проверка токена с кэшем и дедупликацией.
 * Зависимости можно подменить в тестах.
 *
 * @returns {Promise<{status: string, authenticated: boolean|null, rateLimited: boolean,
 *                    cached: boolean, checkedAt: number}>}
 */
export async function checkQwenAuthLive(token, {
    pingFn = pingQwenToken,
    cacheTtlMs = AUTH_STATUS_CACHE_TTL_MS,
    retryCount = AUTH_STATUS_RETRY_COUNT,
    retryDelayMs = AUTH_STATUS_RETRY_DELAY_MS,
    now = () => Date.now()
} = {}) {
    if (typeof token !== 'string' || !token) {
        return { ...classifyPingResult('ERROR'), error: 'Нет токена для проверки', cached: false, checkedAt: now() };
    }

    if (cacheTtlMs > 0) {
        const entry = cache.get(token);
        if (entry && now() - entry.checkedAt < cacheTtlMs) {
            return { ...entry.result, cached: true, checkedAt: entry.checkedAt };
        }
    }
    if (inflight.has(token)) return inflight.get(token);

    const promise = (async () => {
        const raw = await pingQwenTokenWithRetry(token, { pingFn, retryCount, retryDelayMs });
        const checkedAt = now();
        const result = { ...classifyPingResult(raw), cached: false, checkedAt };
        if (cacheTtlMs > 0) {
            cache.set(token, { result, checkedAt });
            pruneCache(cacheTtlMs, checkedAt);
        }
        return result;
    })();

    inflight.set(token, promise);
    try {
        return await promise;
    } finally {
        inflight.delete(token);
    }
}

export function clearAuthStatusCache() {
    cache.clear();
}
