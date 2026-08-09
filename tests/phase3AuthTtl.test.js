import assert from 'node:assert/strict';
import { test } from 'node:test';

// ВАЖНО: config.js читает env при первом импорте, поэтому BROWSER_AUTH_TTL_MS
// устанавливаем ДО первого импорта проекта, внутри async-обёртки
// (finally удаляет env только после завершения тела — см. phase3AuthCheck).
async function withShortTtlEnv(fn) {
    process.env.BROWSER_AUTH_TTL_MS = '100';
    try {
        return await fn();
    } finally {
        delete process.env.BROWSER_AUTH_TTL_MS;
    }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Обёрнут в withShortTtlEnv, чтобы ПЕРВЫЙ импорт config.js/browser.js в этом
// процессе произошёл с env — иначе BROWSER_AUTH_TTL_MS закэшируется со значением
// по умолчанию (12ч) и интеграционные тесты ниже увидят не тот TTL.
test('isAuthConfirmed: чистая логика TTL (включая отключённый TTL=0)', async () => {
    await withShortTtlEnv(async () => {
        const { isAuthConfirmed } = await import('../src/browser/browser.js');
        const now = 10_000;

        assert.equal(isAuthConfirmed(0, 1000, now), false, 'не подтверждалась → false');
        assert.equal(isAuthConfirmed(now, 1000, now), true, 'свежее подтверждение → true');
        assert.equal(isAuthConfirmed(now - 999, 1000, now), true, 'в пределах TTL → true');
        assert.equal(isAuthConfirmed(now - 1000, 1000, now), true, 'граница TTL (<=) → true');
        assert.equal(isAuthConfirmed(now - 1001, 1000, now), false, 'после TTL → false');
        assert.equal(isAuthConfirmed(now - 5000, 0, now), true, 'TTL=0 (отключён) → не протухает');
    });
});

test('кэш-флаг авторизации протухает через BROWSER_AUTH_TTL_MS', async () => {
    await withShortTtlEnv(async () => {
        const browserMod = await import('../src/browser/browser.js');
        const cfg = await import('../src/config.js');
        assert.equal(cfg.BROWSER_AUTH_TTL_MS, 100, 'env-переменная применилась к конфигу');

        browserMod.setAuthenticationStatus(false);
        assert.equal(browserMod.getAuthenticationStatus(), false);

        browserMod.setAuthenticationStatus(true);
        assert.equal(browserMod.getAuthenticationStatus(), true, 'сразу после подтверждения — авторизован');

        await delay(250); // > TTL 100мс
        assert.equal(browserMod.getAuthenticationStatus(), false, 'после TTL флаг протухает');

        browserMod.setAuthenticationStatus(true);
        assert.equal(browserMod.getAuthenticationStatus(), true, 'повторное подтверждение обновляет TTL');

        browserMod.setAuthenticationStatus(false);
        assert.equal(browserMod.getAuthenticationStatus(), false, 'явный сброс — мгновенно false');
    });
});

test('свежий флаг НЕ протухает в пределах TTL', async () => {
    await withShortTtlEnv(async () => {
        const browserMod = await import('../src/browser/browser.js');
        browserMod.setAuthenticationStatus(true);
        await delay(50); // < TTL 100мс
        assert.equal(browserMod.getAuthenticationStatus(), true);
        browserMod.setAuthenticationStatus(false);
    });
});
