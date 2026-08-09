import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ВАЖНО: никаких статических импортов модулей, тянущих config.js/browser.js —
// иначе NON_INTERACTIVE/RETRY_DELAY закэшируются до установки env. Модули
// импортируем динамически внутри тестов.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Реальная session/ пользователя. Её НИКОГДА не удаляем: тесты пишут/чистят
// только изолированную temp-директорию (см. withNonInteractiveEnv).
const REAL_SESSION_DIR = path.join(__dirname, '..', 'session');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function withHangGuard(promise, ms = 1500) {
    return Promise.race([
        promise,
        delay(ms).then(() => { throw new Error('HUNG: операция заблокировалась на stdin (промпт ожидает ввода)'); })
    ]);
}

// Тесты работают без реального браузера: NON_INTERACTIVE исключает интерактивные
// промпты, а маленький RETRY_DELAY ускоряет extractAuthToken.
// ВАЖНО: async + `return await fn()` — иначе finally удалит env ДО завершения
// внутреннего async-тела (и его динамических импортов), и config.js закэшируется
// со значениями по умолчанию.
async function withNonInteractiveEnv(fn) {
    // Изолированная session-директория: config.js прочитает SESSION_DIR при первом
    // динамическом импорте, и все записи saveSession пойдут в temp, а не в
    // реальную session/ пользователя.
    const testSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-session-test-'));
    process.env.SESSION_DIR = testSessionDir;
    process.env.NON_INTERACTIVE = '1';
    process.env.RETRY_DELAY = '1';
    process.env.AUTH_CHECK_NEGATIVE_CACHE_MS = '60000'; // окно кэша: между вызовами в тесте
    try {
        return await fn();
    } finally {
        delete process.env.NON_INTERACTIVE;
        delete process.env.RETRY_DELAY;
        delete process.env.AUTH_CHECK_NEGATIVE_CACHE_MS;
        delete process.env.SESSION_DIR;
        fs.rmSync(testSessionDir, { recursive: true, force: true });
    }
}

// Фейковая страница: достаточно методов, чтобы пройти getPageFromContext,
// extractAuthToken (evaluate возвращает «токен из localStorage») и saveSession.
function makeFakePage({ token = 'test-token', title = 'Qwen Studio' } = {}) {
    return {
        title: async () => title,
        goto: async () => {},
        reload: async () => {},
        cookies: async () => [],
        evaluate: async () => token,
        close: async () => {}
    };
}

// Страховка: чистим только тестовую директорию из env. Если env не задан —
// реальную session/ пользователя НЕ трогаем (раньше here тест стирал её).
function cleanupSessionDir() {
    const target = process.env.SESSION_DIR;
    if (!target || target === REAL_SESSION_DIR) return;
    fs.rmSync(target, { recursive: true, force: true });
}

after(() => cleanupSessionDir());

async function runCheckAuthentication(page, pingFn) {
    const { checkAuthentication, resetAuthCheckCooldown } = await import('../src/browser/auth.js');
    const browserMod = await import('../src/browser/browser.js');
    browserMod.setAuthenticationStatus(false); // сбрасываем кэш-флаг между тестами
    resetAuthCheckCooldown();                  // и негативный кэш
    const result = await withHangGuard(checkAuthentication(page, { pingFn }));
    return { result, browserMod };
}

// Обёрнут в withNonInteractiveEnv, чтобы ПЕРВЫЙ импорт auth.js (а значит и
// config.js) произошёл с правильными env — иначе NON_INTERACTIVE/RETRY_DELAY
// закэшируются со значениями по умолчанию для всех следующих тестов файла.
test('resolveAuthConfirmation: подтверждает только OK/RATELIMIT', async () => {
    await withNonInteractiveEnv(async () => {
        const { resolveAuthConfirmation } = await import('../src/browser/auth.js');
        assert.equal(resolveAuthConfirmation('OK'), 'confirmed');
        assert.equal(resolveAuthConfirmation('RATELIMIT'), 'confirmed');
        assert.equal(resolveAuthConfirmation('UNAUTHORIZED'), 'expired');
        assert.equal(resolveAuthConfirmation('NO_TOKEN'), 'expired');
        assert.equal(resolveAuthConfirmation('ERROR'), 'unconfirmed');
    });
});

test('detectVerificationPage: детекция по URL/содержимому, а не только по title', async () => {
    await withNonInteractiveEnv(async () => {
        const { detectVerificationPage } = await import('../src/browser/auth.js');

        // URL
        assert.equal(detectVerificationPage({ url: 'https://chat.qwen.ai/verification' }), true);
        assert.equal(detectVerificationPage({ url: 'https://chat.qwen.ai/verify' }), true);
        assert.equal(detectVerificationPage({ url: 'https://chat.qwen.ai/captcha?x=1' }), true);
        assert.equal(detectVerificationPage({ url: 'https://chat.qwen.ai/punish' }), true);
        assert.equal(detectVerificationPage({ url: 'https://chat.qwen.ai/safety-check' }), true);

        // Анти-бот WAF Alibaba и капча по содержимому
        assert.equal(detectVerificationPage({ text: '_____tmd_____/punish x5sec' }), true);
        assert.equal(detectVerificationPage({ text: '{"action":"captcha"}' }), true);
        assert.equal(detectVerificationPage({ text: 'Пожалуйста, подтвердите, что вы не робот' }), true);
        assert.equal(detectVerificationPage({ text: 'Подтвердите, что вы человек, чтобы продолжить' }), true);
        assert.equal(detectVerificationPage({ text: 'Verify you are human to continue' }), true);
        assert.equal(detectVerificationPage({ text: 'Human verification required' }), true);

        // Обычная страница Qwen Studio — НЕ верификация, даже если в тексте
        // встречается похожее слово вне маркерных фраз
        assert.equal(detectVerificationPage({
            title: 'Qwen Studio',
            url: 'https://chat.qwen.ai/',
            text: 'Start a new chat. Models: qwen3-max. All systems operational.'
        }), false);
        assert.equal(detectVerificationPage({}), false);

        // title — запасной сигнал, работает по-прежнему
        assert.equal(detectVerificationPage({ title: 'Verification' }), true);
    });
});

test('checkAuthentication подтверждает сессию ТОЛЬКО когда ping токена вернул OK', async () => {
    await withNonInteractiveEnv(async () => {
        const pingedTokens = [];
        const page = makeFakePage({ token: 'real-token' });
        const { result, browserMod } = await runCheckAuthentication(page, async (token) => {
            pingedTokens.push(token);
            return 'OK';
        });

        assert.equal(result, true, 'ping OK должен подтвердить авторизацию');
        assert.deepEqual(pingedTokens, ['real-token'], 'пинговать нужно именно извлечённый токен');
        assert.equal(browserMod.getAuthenticationStatus(), true);
    });
});

test('checkAuthentication подтверждает сессию при RATELIMIT (токен валиден)', async () => {
    await withNonInteractiveEnv(async () => {
        const { result, browserMod } = await runCheckAuthentication(makeFakePage(), async () => 'RATELIMIT');
        assert.equal(result, true);
        assert.equal(browserMod.getAuthenticationStatus(), true);
    });
});

test('checkAuthentication НЕ помечает авторизованным при UNAUTHORIZED (сессия истекла)', async () => {
    await withNonInteractiveEnv(async () => {
        const { result, browserMod } = await runCheckAuthentication(makeFakePage({ token: 'expired-token' }), async () => 'UNAUTHORIZED');
        assert.equal(result, false);
        assert.equal(browserMod.getAuthenticationStatus(), false, '401 — сессия не подтверждена');
    });
});

test('checkAuthentication НЕ помечает авторизованным при ERROR (WAF/сеть)', async () => {
    await withNonInteractiveEnv(async () => {
        const { result, browserMod } = await runCheckAuthentication(makeFakePage(), async () => 'ERROR');
        assert.equal(result, false);
        assert.equal(browserMod.getAuthenticationStatus(), false, 'ERROR — статус не подтверждён');
    });
});

test('checkAuthentication НЕ помечает авторизованным без извлечённого токена (ping не вызывается)', async () => {
    await withNonInteractiveEnv(async () => {
        let pingCalls = 0;
        const { result, browserMod } = await runCheckAuthentication(
            makeFakePage({ token: null }),
            async () => { pingCalls += 1; return 'OK'; }
        );
        assert.equal(result, false);
        assert.equal(pingCalls, 0, 'без токена пинговать нечего');
        assert.equal(browserMod.getAuthenticationStatus(), false);
    });
});

test('checkAuthentication не вызывает ping при уже подтверждённом статусе (кэш-флаг)', async () => {
    await withNonInteractiveEnv(async () => {
        const { checkAuthentication } = await import('../src/browser/auth.js');
        const browserMod = await import('../src/browser/browser.js');
        browserMod.setAuthenticationStatus(true);

        let pingCalls = 0;
        const result = await withHangGuard(checkAuthentication(makeFakePage(), { pingFn: async () => { pingCalls += 1; return 'OK'; } }));
        assert.equal(result, true);
        assert.equal(pingCalls, 0, 'при активном статусе повторный ping не нужен');
        browserMod.setAuthenticationStatus(false);
    });
});

test('startManualAuthentication отказывается работать в NON_INTERACTIVE без блокировки', async () => {
    await withNonInteractiveEnv(async () => {
        const { startManualAuthentication } = await import('../src/browser/auth.js');
        const result = await withHangGuard(startManualAuthentication({}));
        assert.equal(result, false);
    });
});

test('isInAuthCheckCooldown: окно негативного кэша (чистая функция)', async () => {
    await withNonInteractiveEnv(async () => {
        const { isInAuthCheckCooldown } = await import('../src/browser/auth.js');
        assert.equal(isInAuthCheckCooldown(0, 30_000), false, 'прогона не было — кэша нет');
        assert.equal(isInAuthCheckCooldown(1_000, 0), false, 'cooldownMs=0 — кэш отключён');
        assert.equal(isInAuthCheckCooldown(1_000, 30_000, 10_000), true, 'в окне — кэш активен');
        assert.equal(isInAuthCheckCooldown(1_000, 30_000, 31_000), false, 'на границе окна — уже пора проверять');
        assert.equal(isInAuthCheckCooldown(1_000, 30_000, 60_000), false, 'после окна — пора проверять');
    });
});

test('checkAuthentication: без сессии повторный вызов не гоняет браузер (негативный кэш)', async () => {
    await withNonInteractiveEnv(async () => {
        const { checkAuthentication, resetAuthCheckCooldown } = await import('../src/browser/auth.js');
        const browserMod = await import('../src/browser/browser.js');
        browserMod.setAuthenticationStatus(false);
        resetAuthCheckCooldown();

        const page = { ...makeFakePage({ token: null }), gotoCalls: 0, goto: async () => { page.gotoCalls += 1; } };
        const pingFn = async () => { throw new Error('ping не должен вызываться без токена'); };

        const first = await withHangGuard(checkAuthentication(page, { pingFn }));
        assert.equal(first, false, 'NO_TOKEN — не авторизован');
        const gotoCallsAfterFirst = page.gotoCalls;
        assert.ok(gotoCallsAfterFirst > 0, 'первый прогон должен дойти до браузера');

        const second = await withHangGuard(checkAuthentication(page, { pingFn }));
        assert.equal(second, false);
        assert.equal(page.gotoCalls, gotoCallsAfterFirst, 'в окне негативного кэша браузерный goto не повторяется');

        resetAuthCheckCooldown();
        const third = await withHangGuard(checkAuthentication(page, { pingFn }));
        assert.equal(third, false);
        assert.ok(page.gotoCalls > gotoCallsAfterFirst, 'после сброса кэша проверка снова доходит до браузера');
    });
});

test('checkAuthentication: ERROR тоже попадает в негативный кэш (goto и ping не повторяются)', async () => {
    await withNonInteractiveEnv(async () => {
        const { checkAuthentication, resetAuthCheckCooldown } = await import('../src/browser/auth.js');
        const browserMod = await import('../src/browser/browser.js');
        browserMod.setAuthenticationStatus(false);
        resetAuthCheckCooldown();

        let pingCalls = 0;
        const page = { ...makeFakePage({ token: 'waf-token' }), gotoCalls: 0, goto: async () => { page.gotoCalls += 1; } };
        const pingFn = async () => { pingCalls += 1; return 'ERROR'; };

        const first = await withHangGuard(checkAuthentication(page, { pingFn }));
        assert.equal(first, false, 'ERROR — не авторизован');
        assert.equal(pingCalls, 1, 'первый прогон пингует токен');
        const gotoCallsAfterFirst = page.gotoCalls;

        const second = await withHangGuard(checkAuthentication(page, { pingFn }));
        assert.equal(second, false);
        assert.equal(page.gotoCalls, gotoCallsAfterFirst, 'в окне кэша goto не повторяется');
        assert.equal(pingCalls, 1, 'в окне кэша ping не повторяется');

        resetAuthCheckCooldown();
        const third = await withHangGuard(checkAuthentication(page, { pingFn }));
        assert.equal(third, false);
        assert.ok(page.gotoCalls > gotoCallsAfterFirst, 'после сброса кэша goto снова выполняется');
        assert.equal(pingCalls, 2, 'после сброса кэша ping снова выполняется');
    });
});

test('checkAuthentication: cooldownMs=0 отключает негативный кэш', async () => {
    await withNonInteractiveEnv(async () => {
        const { checkAuthentication, resetAuthCheckCooldown } = await import('../src/browser/auth.js');
        const browserMod = await import('../src/browser/browser.js');
        browserMod.setAuthenticationStatus(false);
        resetAuthCheckCooldown();

        const page = { ...makeFakePage({ token: null }), gotoCalls: 0, goto: async () => { page.gotoCalls += 1; } };
        const pingFn = async () => { throw new Error('ping не должен вызываться без токена'); };

        const first = await withHangGuard(checkAuthentication(page, { pingFn, cooldownMs: 0 }));
        assert.equal(first, false);
        const gotoCallsAfterFirst = page.gotoCalls;

        const second = await withHangGuard(checkAuthentication(page, { pingFn, cooldownMs: 0 }));
        assert.equal(second, false);
        assert.ok(page.gotoCalls > gotoCallsAfterFirst, 'с выключенным кэшем проверка выполняется каждый раз');
    });
});
