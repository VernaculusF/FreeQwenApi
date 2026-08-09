import assert from 'node:assert/strict';
import { test } from 'node:test';

// ВАЖНО: никаких статических импортов модулей, которые тянут config.js —
// иначе NON_INTERACTIVE/RETRY_DELAY будут закэшированы до установки env,
// и проверки неинтерактивного режима не сработают (или зависнут на stdin).
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function withNonInteractiveEnv(fn) {
    process.env.NON_INTERACTIVE = '1';
    process.env.RETRY_DELAY = '1';
    try {
        return await fn();
    } finally {
        delete process.env.NON_INTERACTIVE;
        delete process.env.RETRY_DELAY;
    }
}

function withHangGuard(promise, ms = 1500) {
    return Promise.race([
        promise,
        delay(ms).then(() => { throw new Error('HUNG: операция заблокировалась на stdin (промпт ожидает ввода)'); })
    ]);
}

test('checkVerification does not block on stdin in NON_INTERACTIVE mode', async () => {
    await withNonInteractiveEnv(async () => {
        const { checkVerification } = await import('../src/browser/auth.js');
        const fakePage = { title: async () => 'Verification' };
        const result = await withHangGuard(checkVerification(fakePage));
        assert.equal(result, true);
    });
});

test('checkAuthentication returns false without blocking on stdin in NON_INTERACTIVE mode', async () => {
    await withNonInteractiveEnv(async () => {
        const { checkAuthentication } = await import('../src/browser/auth.js');
        const fakePage = {
            title: async () => 'Verification',
            goto: async () => {},
            reload: async () => {}
        };
        const result = await withHangGuard(checkAuthentication(fakePage));
        assert.equal(result, false);
    });
});

test('startManualAuthentication refuses to run in NON_INTERACTIVE mode', async () => {
    await withNonInteractiveEnv(async () => {
        const { startManualAuthentication } = await import('../src/browser/auth.js');
        const result = await withHangGuard(startManualAuthentication({}));
        assert.equal(result, false);
    });
});

test('browser watchdog start/stop is idempotent and safe without a browser', async () => {
    const browser = await import('../src/browser/browser.js');
    browser.stopBrowserWatchdog();
    browser.startBrowserWatchdog();
    browser.startBrowserWatchdog(); // повторный вызов не должен плодить таймеры
    browser.stopBrowserWatchdog();
    browser.stopBrowserWatchdog();
    assert.ok(true);
});
