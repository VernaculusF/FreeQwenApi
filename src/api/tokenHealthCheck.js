// tokenHealthCheck.js — фоновый healthcheck аккаунтов Qwen по расписанию.
//
// Периодически проверяет каждый валидный токен через pingQwenToken() (лёгкий
// ping в Qwen Chat из браузерного контекста, единый модуль qwenPing.js) и заранее помечает:
//   - UNAUTHORIZED  → markInvalidByToken (аккаунт больше не используется)
//   - RATELIMIT     → markRateLimitedByToken (аккаунт уходит в resetAt)
//   - OK            → ничего не делаем (аккаунт рабочий)
//   - ERROR         → транзиентный сбой (браузер/сеть) — НЕ трогаем токен,
//                     чтобы не «сжигать» аккаунты из-за кратковременных проблем.
//
// Проверки идут строго последовательно с паузой TOKEN_HEALTH_CHECK_DELAY_MS,
// чтобы не провоцировать anti-bot Qwen массовыми запросами. Таймеры unref'нуты:
// хелсчек никогда не держит процесс живым.

import { logInfo, logWarn, logDebug } from '../logger/index.js';
import { listTokens, markInvalidByToken, markRateLimitedByToken } from './tokenManager.js';
import { pingQwenToken, classifyPingResult } from './qwenPing.js';
import {
    TOKEN_HEALTH_CHECK_INTERVAL_MS,
    TOKEN_HEALTH_CHECK_INITIAL_DELAY_MS,
    TOKEN_HEALTH_CHECK_DELAY_MS
} from '../config.js';

let timer = null;
let initialTimer = null;
let running = false;

export function isTokenHealthCheckEnabled() {
    return TOKEN_HEALTH_CHECK_INTERVAL_MS > 0;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Классификация результата ping в действие над аккаунтом.
 * Делигирует в единый classifyPingResult из qwenPing.js.
 */
export function classifyTokenHealth(status) {
    const { status: s } = classifyPingResult(status);
    if (s === 'unauthorized') return 'invalid';
    if (s === 'ratelimit') return 'ratelimited';
    if (s === 'ok') return 'ok';
    return 'error';
}

/**
 * Один прогон healthcheck'а. Зависимости можно подменить в тестах.
 * Возвращает сводку; { skipped: true } — если предыдущий прогон ещё идёт.
 */
export async function runTokenHealthCheck({
    checkToken = pingQwenToken,
    list = listTokens,
    markInvalid = markInvalidByToken,
    markRateLimited = markRateLimitedByToken,
    betweenDelayMs = TOKEN_HEALTH_CHECK_DELAY_MS
} = {}) {
    if (running) return { skipped: true };

    running = true;
    try {
        const tokens = list();
        const now = Date.now();
        const candidates = tokens.filter(t =>
            Boolean(t?.token)
            && t.invalid !== true
            && (!t.resetAt || new Date(t.resetAt).getTime() <= now)
        );

        if (candidates.length === 0) {
            logDebug('Токен-хелсчек: нет аккаунтов для проверки.');
            return { checked: 0, ok: 0, invalid: 0, ratelimited: 0, errors: 0 };
        }

        let ok = 0;
        let invalid = 0;
        let ratelimited = 0;
        let errors = 0;

        for (const token of candidates) {
            let status = 'ERROR';
            try {
                status = await checkToken(token.token);
            } catch (e) {
                logWarn(`Токен-хелсчек: ошибка при проверке аккаунта ${token.id}: ${e.message}`);
            }

            const action = classifyTokenHealth(status);
            if (action === 'invalid') {
                markInvalid(token.token);
                invalid++;
                logWarn(`Токен-хелсчек: аккаунт ${token.id} недействителен (401/403) — помечен как invalid.`);
            } else if (action === 'ratelimited') {
                markRateLimited(token.token);
                ratelimited++;
                logWarn(`Токен-хелсчек: аккаунт ${token.id} в rate-limit (429) — помечен как ожидающий сброса.`);
            } else if (action === 'ok') {
                ok++;
            } else {
                errors++;
                logDebug(`Токен-хелсчек: аккаунт ${token.id} — транзиентная ошибка (${status}), токен не трогаем.`);
            }

            if (betweenDelayMs > 0) await delay(betweenDelayMs);
        }

        logInfo(`Токен-хелсчек: проверено ${candidates.length} аккаунтов — OK: ${ok}, недействительных: ${invalid}, rate-limit: ${ratelimited}, ошибок: ${errors}.`);
        return { checked: candidates.length, ok, invalid, ratelimited, errors };
    } finally {
        running = false;
    }
}

export function startTokenHealthCheck() {
    if (!isTokenHealthCheckEnabled() || timer || initialTimer) return;
    logInfo(`Токен-хелсчек запущен: первый прогон через ${Math.round(TOKEN_HEALTH_CHECK_INITIAL_DELAY_MS / 1000)}с, далее каждые ${Math.round(TOKEN_HEALTH_CHECK_INTERVAL_MS / 1000)}с.`);

    initialTimer = setTimeout(() => {
        initialTimer = null;
        runTokenHealthCheck().catch(e => logWarn(`Токен-хелсчек: ошибка прогона: ${e.message}`));
        timer = setInterval(() => {
            runTokenHealthCheck().catch(e => logWarn(`Токен-хелсчек: ошибка прогона: ${e.message}`));
        }, TOKEN_HEALTH_CHECK_INTERVAL_MS);
        if (timer.unref) timer.unref();
    }, TOKEN_HEALTH_CHECK_INITIAL_DELAY_MS);
    if (initialTimer.unref) initialTimer.unref();
}

export function stopTokenHealthCheck() {
    if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
    }
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
