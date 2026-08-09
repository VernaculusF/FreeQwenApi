import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAuthDecision } from '../src/api/authPolicy.js';

test('authPolicy: пустой список ключей без REQUIRE_API_KEYS = открытый прокси (обратная совместимость)', () => {
    const decision = resolveAuthDecision({ apiKeys: [], authHeader: undefined, requireApiKeys: false });
    assert.deepEqual(decision, { ok: true, fingerprint: null });
});

test('authPolicy: REQUIRE_API_KEYS с пустым списком ключей = отказ 401', () => {
    const decision = resolveAuthDecision({ apiKeys: [], authHeader: undefined, requireApiKeys: true });
    assert.equal(decision.ok, false);
    assert.equal(decision.status, 401);
    assert.match(decision.error, /Authorization\.txt/);
});

test('authPolicy: ключи есть, заголовок отсутствует = 401', () => {
    const decision = resolveAuthDecision({ apiKeys: ['secret-a'], authHeader: undefined, requireApiKeys: false });
    assert.equal(decision.ok, false);
    assert.equal(decision.status, 401);
    assert.match(decision.error, /Требуется авторизация/);
});

test('authPolicy: ключи есть, заголовок не Bearer = 401', () => {
    const decision = resolveAuthDecision({ apiKeys: ['secret-a'], authHeader: 'Basic abc', requireApiKeys: false });
    assert.equal(decision.ok, false);
    assert.equal(decision.status, 401);
});

test('authPolicy: неверный ключ = 401', () => {
    const decision = resolveAuthDecision({ apiKeys: ['secret-a'], authHeader: 'Bearer wrong-key', requireApiKeys: false });
    assert.equal(decision.ok, false);
    assert.equal(decision.status, 401);
    assert.match(decision.error, /Недействительный токен/);
});

test('authPolicy: верный ключ = ok c fingerprint (без хранения самого ключа)', () => {
    const decision = resolveAuthDecision({ apiKeys: ['secret-a', 'secret-b'], authHeader: 'Bearer secret-b', requireApiKeys: false });
    assert.equal(decision.ok, true);
    assert.equal(typeof decision.fingerprint, 'string');
    assert.ok(decision.fingerprint.length > 0);
    assert.notEqual(decision.fingerprint, 'secret-b');
});

test('authPolicy: пробелы вокруг Bearer-токена не мешают', () => {
    const decision = resolveAuthDecision({ apiKeys: ['secret-a'], authHeader: 'Bearer   secret-a   ', requireApiKeys: false });
    assert.equal(decision.ok, true);
});

test('authPolicy: REQUIRE_API_KEYS с настроенными ключами работает как обычно', () => {
    const good = resolveAuthDecision({ apiKeys: ['secret-a'], authHeader: 'Bearer secret-a', requireApiKeys: true });
    assert.equal(good.ok, true);
    const bad = resolveAuthDecision({ apiKeys: ['secret-a'], authHeader: 'Bearer nope', requireApiKeys: true });
    assert.equal(bad.ok, false);
});
