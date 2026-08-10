import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWafRetryHang } from '../src/api/chat.js';

const ctx = { forceBrowserFetch: true, retryCount: 1 };

test('isWafRetryHang: сетевой обрыв после солва — это ре-челлендж', () => {
  assert.equal(isWafRetryHang({ error: 'TypeError: network error' }, ctx), true);
  assert.equal(isWafRetryHang({ error: 'Failed to fetch' }, ctx), true);
  assert.equal(isWafRetryHang({ error: 'Запрос к Qwen API: превышен таймаут' }, ctx), true);
});

test('isWafRetryHang: не для обычного запроса (не ретрая)', () => {
  assert.equal(isWafRetryHang({ error: 'TypeError: network error' }, { forceBrowserFetch: false, retryCount: 1 }), false);
  assert.equal(isWafRetryHang({ error: 'TypeError: network error' }, {}), false);
});

test('isWafRetryHang: non-SSE 200 на ретрае — тоже лечим пробой+солвом', () => {
  assert.equal(isWafRetryHang({ error: 'Unexpected non-SSE 200 response', errorBody: '<html>not-sse</html>' }, ctx), true);
  // но только для ретрая после солва
  assert.equal(isWafRetryHang({ error: 'Unexpected non-SSE 200 response', errorBody: '<html>' }, { forceBrowserFetch: false, retryCount: 1 }), false);
});

test('isWafRetryHang: структурные ответы (статус/тело/antiBot) не лечим как зависание', () => {
  assert.equal(isWafRetryHang({ status: 500, error: 'network' }, ctx), false);
  assert.equal(isWafRetryHang({ errorBody: '<html>', error: 'network' }, ctx), false);
  assert.equal(isWafRetryHang({ antiBot: true, error: 'network' }, ctx), false);
});

test('isWafRetryHang: отменённый клиентом запрос не трогаем', () => {
  assert.equal(isWafRetryHang({ aborted: true, error: 'aborted' }, ctx), false);
});

test('isWafRetryHang: лимит ретраев уважается', () => {
  assert.equal(isWafRetryHang({ error: 'network' }, { forceBrowserFetch: true, retryCount: 3 }), false);
});

test('isWafRetryHang: не-сетевая ошибка не триггерит восстановление', () => {
  assert.equal(isWafRetryHang({ error: 'JSON parse error' }, ctx), false);
  assert.equal(isWafRetryHang({}, ctx), false);
});
