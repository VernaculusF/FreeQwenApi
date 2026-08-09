// authPolicy.js — чистая логика авторизации прокси-ключами.
// Вынесена из routes.js отдельно, чтобы unit-тесты могли импортировать её
// без express-роутера (который держит живой setInterval на уровне модуля).

import { fingerprintClientCredential, matchesClientCredential } from './keyedQueue.js';

/**
 * Чистое решение авторизации прокси-ключа.
 *
 * @param {object} params
 * @param {string[]} params.apiKeys — валидные ключи из Authorization.txt
 * @param {string|undefined} params.authHeader — значение заголовка Authorization
 * @param {boolean} [params.requireApiKeys] — REQUIRE_API_KEYS: пустой список ключей = отказ
 * @returns {{ ok: true, fingerprint: string|null } | { ok: false, status: number, error: string }}
 */
export function resolveAuthDecision({ apiKeys, authHeader, requireApiKeys = false }) {
    if (requireApiKeys && apiKeys.length === 0) {
        return { ok: false, status: 401, error: 'API-ключи не настроены: заполните Authorization.txt' };
    }
    if (apiKeys.length === 0) {
        return { ok: true, fingerprint: null };
    }
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { ok: false, status: 401, error: 'Требуется авторизация' };
    }

    const token = authHeader.substring(7).trim();
    if (!matchesClientCredential(token, apiKeys)) {
        return { ok: false, status: 401, error: 'Недействительный токен' };
    }
    // Keep only a one-way fingerprint on the request; never persist or log the
    // validated proxy bearer itself.
    return { ok: true, fingerprint: fingerprintClientCredential(token) };
}
