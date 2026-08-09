import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withOperationGuard } from '../src/utils/operationGuard.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('withOperationGuard resolves with the underlying value on success', async () => {
    const result = await withOperationGuard(Promise.resolve(42), { timeoutMs: 1000, label: 'x' });
    assert.equal(result, 42);
});

test('withOperationGuard rejects with ETIMEDOUT and fires onAbort when the operation exceeds the timeout', async () => {
    let aborted = 0;
    const slow = new Promise(resolve => setTimeout(resolve, 200));
    await assert.rejects(
        withOperationGuard(slow, { timeoutMs: 20, label: 'slow op', onAbort: () => { aborted += 1; } }),
        /превышен таймаут/
    );
    assert.equal(aborted, 1);
});

test('withOperationGuard passes through errors of the underlying promise without firing onAbort', async () => {
    let aborted = 0;
    await assert.rejects(
        withOperationGuard(Promise.reject(new Error('boom')), { timeoutMs: 1000, onAbort: () => { aborted += 1; } }),
        /boom/
    );
    assert.equal(aborted, 0);
});

test('withOperationGuard rejects with ABORTED and fires onAbort when the signal aborts', async () => {
    let aborted = 0;
    const controller = new AbortController();
    const never = new Promise(() => {});
    const guard = withOperationGuard(never, { signal: controller.signal, label: 'abortable', onAbort: () => { aborted += 1; } });
    const rejection = assert.rejects(guard, /отменён клиентом/);
    controller.abort();
    await rejection;
    assert.equal(aborted, 1);
});

test('withOperationGuard rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        withOperationGuard(new Promise(() => {}), { signal: controller.signal, label: 'already aborted' }),
        /отменён клиентом/
    );
});

test('withOperationGuard returns the promise untouched when no timeout/signal is provided', () => {
    const inner = Promise.resolve('ok');
    assert.equal(withOperationGuard(inner, {}), inner);
});

test('withOperationGuard cleans up its timer when the operation completes first', async () => {
    let onAbortFired = 0;
    const result = await withOperationGuard(Promise.resolve('fast'), { timeoutMs: 50, onAbort: () => { onAbortFired += 1; } });
    assert.equal(result, 'fast');
    await delay(80); // если таймер не очищен — он бы истёк и вызвал onAbort
    assert.equal(onAbortFired, 0);
});
