import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkQwenAuthLive, normalizeLiveStatus, clearAuthStatusCache } from '../src/api/authStatusCheck.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test.beforeEach(() => clearAuthStatusCache());

test('normalizeLiveStatus: маппинг статусов Qwen', () => {
    assert.deepEqual(normalizeLiveStatus('OK'), { status: 'ok', authenticated: true, rateLimited: false });
    assert.deepEqual(normalizeLiveStatus('UNAUTHORIZED'), { status: 'unauthorized', authenticated: false, rateLimited: false });
    assert.deepEqual(normalizeLiveStatus('RATELIMIT'), { status: 'ratelimit', authenticated: true, rateLimited: true });
    assert.deepEqual(normalizeLiveStatus('ERROR'), { status: 'error', authenticated: null, rateLimited: false });
    assert.deepEqual(normalizeLiveStatus('неизвестно'), { status: 'error', authenticated: null, rateLimited: false });
});

test('checkQwenAuthLive: OK — успех, UNAUTHORIZED — финал без retry', async () => {
    let calls = 0;
    const ok = await checkQwenAuthLive('tok', {
        pingFn: () => { calls += 1; return Promise.resolve('OK'); },
        retryCount: 3
    });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.authenticated, true);
    assert.equal(ok.cached, false);
    assert.equal(calls, 1);

    const bad = await checkQwenAuthLive('tok2', {
        pingFn: () => { calls += 1; return Promise.resolve('UNAUTHORIZED'); },
        retryCount: 3
    });
    assert.equal(bad.status, 'unauthorized');
    assert.equal(bad.authenticated, false);
    assert.equal(calls, 2); // UNAUTHORIZED не ретраится
});

test('checkQwenAuthLive: кэш — повторный вызов в пределах TTL не бьёт в Qwen', async () => {
    let calls = 0;
    const fn = () => { calls += 1; return Promise.resolve('OK'); };
    let t = 1000;
    const now = () => t;

    const first = await checkQwenAuthLive('tok', { pingFn: fn, cacheTtlMs: 60_000, now });
    const second = await checkQwenAuthLive('tok', { pingFn: fn, cacheTtlMs: 60_000, now });

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.checkedAt, first.checkedAt);
    assert.equal(calls, 1);

    // TTL истёк — проверка выполняется заново.
    t += 60_001;
    const third = await checkQwenAuthLive('tok', { pingFn: fn, cacheTtlMs: 60_000, now });
    assert.equal(third.cached, false);
    assert.equal(calls, 2);
});

test('checkQwenAuthLive: cacheTtlMs=0 — кэш отключён, каждый вызов живой', async () => {
    let calls = 0;
    const fn = () => { calls += 1; return Promise.resolve('OK'); };
    await checkQwenAuthLive('tok', { pingFn: fn, cacheTtlMs: 0 });
    await checkQwenAuthLive('tok', { pingFn: fn, cacheTtlMs: 0 });
    assert.equal(calls, 2);
});

test('checkQwenAuthLive: лёгкий retry — ERROR затем OK', async () => {
    const sequence = ['ERROR', 'OK'];
    let calls = 0;
    const result = await checkQwenAuthLive('tok', {
        pingFn: () => Promise.resolve(sequence[calls++]),
        retryCount: 2,
        retryDelayMs: 1
    });
    assert.equal(result.status, 'ok');
    assert.equal(calls, 2);
});

test('checkQwenAuthLive: исчерпание retry — status error', async () => {
    let calls = 0;
    const result = await checkQwenAuthLive('tok', {
        pingFn: () => { calls += 1; return Promise.resolve('ERROR'); },
        retryCount: 2,
        retryDelayMs: 1
    });
    assert.equal(result.status, 'error');
    assert.equal(result.authenticated, null);
    assert.equal(calls, 3); // 1 + 2 retry
});

test('checkQwenAuthLive: дедупликация — конкурентные запросы одного токена делают один прогон', async () => {
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });

    const fn = async () => {
        calls += 1;
        await gate;
        return 'OK';
    };

    const p1 = checkQwenAuthLive('tok', { pingFn: fn, retryDelayMs: 0 });
    await delay(5); // даём первому запросу войти в inflight
    const p2 = checkQwenAuthLive('tok', { pingFn: fn, retryDelayMs: 0 });

    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(calls, 1);
    assert.equal(r1.status, 'ok');
    assert.equal(r2.status, 'ok');
    assert.equal(r1.checkedAt, r2.checkedAt);
});

test('checkQwenAuthLive: пустой токен — error без обращения к testToken', async () => {
    let calls = 0;
    const result = await checkQwenAuthLive('', {
        pingFn: () => { calls += 1; return Promise.resolve('OK'); }
    });
    assert.equal(result.status, 'error');
    assert.match(result.error, /Нет токена/);
    assert.equal(calls, 0);
});
