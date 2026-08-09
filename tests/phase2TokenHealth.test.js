import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyTokenHealth, runTokenHealthCheck, isTokenHealthCheckEnabled } from '../src/api/tokenHealthCheck.js';

test('classifyTokenHealth: маппинг статусов в действия', () => {
    assert.equal(classifyTokenHealth('UNAUTHORIZED'), 'invalid');
    assert.equal(classifyTokenHealth('RATELIMIT'), 'ratelimited');
    assert.equal(classifyTokenHealth('OK'), 'ok');
    assert.equal(classifyTokenHealth('ERROR'), 'error');
    assert.equal(classifyTokenHealth('something-else'), 'error');
});

test('runTokenHealthCheck: UNAUTHORIZED помечает invalid, RATELIMIT — rate-limit, OK/ERROR не трогают', async () => {
    const tokens = [
        { id: 'a', token: 'tok-a' },
        { id: 'b', token: 'tok-b' },
        { id: 'c', token: 'tok-c' },
        { id: 'd', token: 'tok-d' }
    ];
    const statusByToken = { 'tok-a': 'UNAUTHORIZED', 'tok-b': 'RATELIMIT', 'tok-c': 'OK', 'tok-d': 'ERROR' };
    const markedInvalid = [];
    const markedRateLimited = [];

    const summary = await runTokenHealthCheck({
        list: () => tokens,
        checkToken: (token) => Promise.resolve(statusByToken[token]),
        markInvalid: (token) => markedInvalid.push(token),
        markRateLimited: (token) => markedRateLimited.push(token),
        betweenDelayMs: 0
    });

    assert.deepEqual(summary, { checked: 4, ok: 1, invalid: 1, ratelimited: 1, errors: 1 });
    assert.deepEqual(markedInvalid, ['tok-a']);
    assert.deepEqual(markedRateLimited, ['tok-b']);
});

test('runTokenHealthCheck: пропускает invalid-аккаунты и ожидающие сброса (resetAt в будущем)', async () => {
    const tokens = [
        { id: 'invalid', token: 'tok-invalid', invalid: true },
        { id: 'waiting', token: 'tok-waiting', resetAt: new Date(Date.now() + 3600_000).toISOString() },
        { id: 'ok', token: 'tok-ok' }
    ];
    const checked = [];

    const summary = await runTokenHealthCheck({
        list: () => tokens,
        checkToken: (token) => { checked.push(token); return Promise.resolve('OK'); },
        markInvalid: () => {},
        markRateLimited: () => {},
        betweenDelayMs: 0
    });

    assert.equal(summary.checked, 1);
    assert.deepEqual(checked, ['tok-ok']);
});

test('runTokenHealthCheck: пустой список аккаунтов — быстрый возврат без ошибок', async () => {
    const summary = await runTokenHealthCheck({
        list: () => [],
        checkToken: () => Promise.resolve('OK'),
        markInvalid: () => {},
        markRateLimited: () => {},
        betweenDelayMs: 0
    });
    assert.deepEqual(summary, { checked: 0, ok: 0, invalid: 0, ratelimited: 0, errors: 0 });
});

test('runTokenHealthCheck: overlap-guard — повторный вызов во время прогона пропускается', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;

    const first = runTokenHealthCheck({
        list: () => [{ id: 'a', token: 'tok-a' }],
        checkToken: () => { calls += 1; return gate; },
        markInvalid: () => {},
        markRateLimited: () => {},
        betweenDelayMs: 0
    });

    // Ждём, пока первый прогон реально начался (checkToken вызван).
    while (calls === 0) { await new Promise(r => setImmediate(r)); }

    const second = await runTokenHealthCheck({
        list: () => [{ id: 'a', token: 'tok-a' }],
        checkToken: () => Promise.resolve('OK'),
        markInvalid: () => {},
        markRateLimited: () => {},
        betweenDelayMs: 0
    });
    assert.deepEqual(second, { skipped: true });

    release('OK');
    const firstResult = await first;
    assert.equal(firstResult.checked, 1);
});

test('isTokenHealthCheckEnabled: включён при дефолтном интервале (> 0)', () => {
    // Дефолтный TOKEN_HEALTH_CHECK_INTERVAL_MS = 3600000, если env не переопределён.
    assert.equal(isTokenHealthCheckEnabled(), true);
});
