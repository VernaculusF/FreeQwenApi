import { saveSession } from './session.js';
import { setAuthenticationStatus, getAuthenticationStatus, restartBrowserInHeadlessMode } from './browser.js';
import { extractAuthToken } from '../api/chat.js';
import { pingQwenTokenWithRetry } from '../api/qwenPing.js';
import { withOperationGuard } from '../utils/operationGuard.js';
import { VERIFICATION_URL_RE, isVerificationText, isWafHtmlBlock } from '../utils/verificationMarkers.js';
import { logInfo, logError, logWarn, logDebug } from '../logger/index.js';
import { CHAT_PAGE_URL, AUTH_SIGNIN_URL, PAGE_TIMEOUT, RETRY_DELAY, NON_INTERACTIVE, PAGE_EVALUATE_TIMEOUT, AUTH_CHECK_NEGATIVE_CACHE_MS } from '../config.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isPlaywright(context) {
    return context && typeof context.newPage === 'function';
}

async function getPage(context) {
    if (context && typeof context.goto === 'function') return context;
    if (context && typeof context.newPage === 'function') return await context.newPage();
    throw new Error('Неверный контекст: не страница Puppeteer, не контекст Playwright');
}

async function promptUser(question) {
    return new Promise(resolve => {
        process.stdout.write(question);
        const onData = (data) => {
            process.stdin.removeListener('data', onData);
            process.stdin.pause();
            resolve(data.toString().trim());
        };
        process.stdin.resume();
        process.stdin.once('data', onData);
    });
}

// ─── Детекция страницы верификации ──────────────────────────────────────────
// Маркеры (URL/заголовок, фразы, WAF) — в едином src/utils/verificationMarkers.js,
// чтобы верификация/анти-бот распознавались одинаково во всех модулях.

/**
 * Чистая функция: определяет, является ли страница страницей верификации/анти-бот.
 *
 * Заголовок (title) — лишь один из сигналов и НЕ обязателен: если Qwen Studio
 * переименует страницу, детекция продолжит работать по URL и содержимому.
 *
 * @param {object} params
 * @param {string} [params.title] — page.title()
 * @param {string} [params.url]   — page.url()
 * @param {string} [params.text]  — первые ~4КБ innerText страницы
 * @returns {boolean}
 */
export function detectVerificationPage({ title = '', url = '', text = '' } = {}) {
    const source = `${String(url || '')} ${String(title || '')}`;
    if (VERIFICATION_URL_RE.test(source)) return true;
    const body = String(text || '');
    return isVerificationText(body) || isWafHtmlBlock(body);
}

// Безопасное чтение метода страницы: отсутствующий метод/ошибка → '' (не падаем).
async function safePageRead(page, method, args = []) {
    try {
        if (typeof page[method] !== 'function') return '';
        const value = await page[method](...args);
        return value == null ? '' : String(value);
    } catch {
        return '';
    }
}

// Первые ~4КБ текста страницы (с таймаутом, чтобы не висеть на верификации).
async function readPageText(page) {
    if (typeof page.evaluate !== 'function') return '';
    try {
        const text = await withOperationGuard(
            page.evaluate(() => (document.body ? document.body.innerText : '')),
            { timeoutMs: PAGE_EVALUATE_TIMEOUT, label: 'Детекция верификации: чтение содержимого' }
        );
        return String(text || '').slice(0, 4000);
    } catch {
        return '';
    }
}

async function detectVerificationOnPage(page) {
    const [title, url, text] = await Promise.all([
        safePageRead(page, 'title'),
        safePageRead(page, 'url'),
        readPageText(page)
    ]);
    return detectVerificationPage({ title, url, text });
}

/**
 * Решение по сырому статусу ping извлечённого токена (чистая функция).
 *
 * Ключевое правило: сессия считается подтверждённой ТОЛЬКО если ping
 * вернул OK (или RATELIMIT — токен валиден, запросы просто лимитированы).
 * UNAUTHORIZED/отсутствие токена — вход не выполнен или сессия истекла.
 * ERROR (сеть/WAF/браузер) — подтвердить невозможно: статус НЕ ставится,
 * токен при этом не «сжигается».
 *
 * @param {string} raw — 'OK' | 'UNAUTHORIZED' | 'RATELIMIT' | 'ERROR' | 'NO_TOKEN'
 * @returns {'confirmed'|'expired'|'unconfirmed'}
 */
export function resolveAuthConfirmation(raw) {
    if (raw === 'OK' || raw === 'RATELIMIT') return 'confirmed';
    if (raw === 'UNAUTHORIZED' || raw === 'NO_TOKEN') return 'expired';
    return 'unconfirmed'; // ERROR
}

/**
 * Пингует извлечённый токен. Возвращает сырой статус либо 'NO_TOKEN'.
 * Исключения из pingFn (в т.ч. подменённой в тестах) сводятся к ERROR.
 */
async function pingTokenStatus(token, pingFn) {
    if (!token) return 'NO_TOKEN';
    try {
        return await pingFn(token);
    } catch (error) {
        logWarn(`Проверка токена не удалась: ${error.message}`);
        return 'ERROR';
    }
}

function isConfirmed(raw) {
    return resolveAuthConfirmation(raw) === 'confirmed';
}

// ─── Негативный кэш проверки авторизации ─────────────────────────────────────
// После неудачного прогона (нет токена / 401 / транзиентная ошибка) не гоняем
// браузерный goto на каждый запрос без сессии — повторная проверка не чаще
// раза в AUTH_CHECK_NEGATIVE_CACHE_MS (0 — отключено).
let lastNegativeCheckAt = 0;

/**
 * Чистая проверка «в окне негативного кэша» (для тестов).
 * @param {number} lastCheckAt — время последнего неудачного прогона (0 = не было)
 * @param {number} cooldownMs — окно, мс (0 = кэш отключён)
 * @param {number} [now] — текущее время
 */
export function isInAuthCheckCooldown(lastCheckAt, cooldownMs, now = Date.now()) {
    if (cooldownMs <= 0 || lastCheckAt <= 0) return false;
    return now - lastCheckAt < cooldownMs;
}

export function resetAuthCheckCooldown() {
    lastNegativeCheckAt = 0;
}

function recordNegativeCheck() {
    lastNegativeCheckAt = Date.now();
}

// Неудачный прогон: снимаем статус и запоминаем время для негативного кэша.
function failAuthCheck() {
    setAuthenticationStatus(false);
    recordNegativeCheck();
    return false;
}

/**
 * Проверка авторизации с подтверждением через ping извлечённого токена.
 *
 * Раньше вход определялся по отсутствию селектора `.login-container` — но в
 * новом UI «Qwen Studio» этого селектора нет, а WAF-капча тоже не содержит
 * формы входа, поэтому «нет формы» ошибочно трактовалось как «авторизован».
 * Теперь «авторизован» ставится ТОЛЬКО когда ping извлечённого токена вернул
 * OK/RATELIMIT. ERROR (анти-бот/сеть) статус не подтверждает — и не сбрасывает
 * в логин без необходимости.
 *
 * @param {object} context — страница или контекст браузера
 * @param {object} [options] — { pingFn, cooldownMs } для подмены в тестах
 */
export async function checkAuthentication(context, { pingFn = pingQwenTokenWithRetry, cooldownMs = AUTH_CHECK_NEGATIVE_CACHE_MS } = {}) {
    try {
        if (getAuthenticationStatus()) return true;

        // Негативный кэш: недавний неудачный прогон (нет сессии) — не повторяем
        // браузерный goto, отвечаем «не авторизован» без обращения к странице.
        if (isInAuthCheckCooldown(lastNegativeCheckAt, cooldownMs)) {
            logDebug('checkAuthentication: негативный кэш — повторная проверка позже (без браузерного goto)');
            return false;
        }

        const page = await getPage(context);
        const isPW = isPlaywright(context);

        logInfo('Проверка авторизации...');

        try {
            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            if (isPW) await page.waitForLoadState('domcontentloaded');
            await delay(RETRY_DELAY);

            if (await detectVerificationOnPage(page)) {
                logWarn('Обнаружена страница верификации/анти-бот (URL или содержимое).');
                if (NON_INTERACTIVE) {
                    logError('NON_INTERACTIVE: пропускаем блокирующий промпт верификации. Пройдите её вручную при интерактивном запуске.');
                    return failAuthCheck();
                }
                await promptUser('После прохождения верификации нажмите ENTER для продолжения...');
                logInfo('Верификация подтверждена пользователем.');
            }

            const token = await extractAuthToken(context, true);
            const raw = await pingTokenStatus(token, pingFn);

            if (isConfirmed(raw)) {
                if (raw === 'OK') {
                    logInfo('Авторизация подтверждена (токен проверен)');
                } else {
                    logWarn('Сессия подтверждена, но запросы временно лимитированы (RATELIMIT)');
                }
                setAuthenticationStatus(true);
                try {
                    await saveSession(context);
                    logInfo('Сессия обновлена');
                } catch (e) { logError('Не удалось обновить сессию', e); }
                if (isPW) await page.close();
                return true;
            }

            if (raw === 'ERROR') {
                // Не подтверждено (сеть/WAF/браузер). Статус НЕ ставим, но и в
                // интерактиве не гоняем оператора в логин без необходимости:
                // следующая проверка повторит ping сама.
                logWarn('Не удалось подтвердить сессию Qwen (транзиентная ошибка). Статус авторизации не подтверждён.');
                setAuthenticationStatus(false);
                recordNegativeCheck();
                if (NON_INTERACTIVE) return false;

                console.log('------------------------------------------------------');
                console.log('               НЕ ПОДТВЕРЖДЕНА СЕССИЯ QWEN');
                console.log('------------------------------------------------------');
                console.log('Не удалось проверить токен (возможно, анти-бот WAF или сбой сети).');
                console.log('Если вы уже вошли — нажмите ENTER для повторной проверки.');
                console.log('Если входа нет — войдите в открытом браузере и нажмите ENTER.');
                console.log('------------------------------------------------------');
                await promptUser('Нажмите ENTER для повторной проверки...');
                logInfo('Повторная проверка после подтверждения пользователя.');

                await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
                await delay(3000);

                const tokenAfter = await extractAuthToken(context, true);
                const rawAfter = await pingTokenStatus(tokenAfter, pingFn);
                if (isConfirmed(rawAfter)) {
                    logInfo('Авторизация подтверждена.');
                    setAuthenticationStatus(true);
                    await saveSession(context);
                    if (isPW) await page.close();
                    return true;
                }
                logWarn('Сессия по-прежнему не подтверждена.');
                return failAuthCheck();
            }

            // raw === 'UNAUTHORIZED' | 'NO_TOKEN' — входа нет или сессия истекла.
            if (NON_INTERACTIVE) {
                logError('NON_INTERACTIVE: браузер не авторизован, а интерактивная авторизация недоступна.');
                return failAuthCheck();
            }

            console.log('------------------------------------------------------');
            console.log('               НЕОБХОДИМА АВТОРИЗАЦИЯ');
            console.log('------------------------------------------------------');
            console.log('1. Войдите в систему через GitHub или другой способ в открытом браузере');
            console.log('2. Дождитесь завершения процесса авторизации');
            console.log('3. Нажмите ENTER в этой консоли');
            console.log('------------------------------------------------------');

            await promptUser('После успешной авторизации нажмите ENTER для продолжения...');
            logInfo('Пользователь подтвердил завершение авторизации.');

            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(3000);

            const tokenAfter = await extractAuthToken(context, true);
            const rawAfter = await pingTokenStatus(tokenAfter, pingFn);

            if (isConfirmed(rawAfter)) {
                logInfo('Авторизация подтверждена.');
                setAuthenticationStatus(true);
                await saveSession(context);
                if (isPW) await page.close();
                return true;
            }

            logWarn('Авторизация не обнаружена.');
            return failAuthCheck();
        } catch (error) {
            if (isPW) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Ошибка при проверке авторизации', error);
        return failAuthCheck();
    }
}

export async function startManualAuthentication(context, skipRestart = false, { pingFn = pingQwenTokenWithRetry } = {}) {
    if (NON_INTERACTIVE) {
        logError('NON_INTERACTIVE: ручная авторизация невозможна. Запустите авторизацию в интерактивном режиме.');
        return false;
    }
    try {
        const page = await getPage(context);
        const isPW = isPlaywright(context);

        logInfo('Открытие страницы для ручной авторизации...');

        try {
            await page.goto(AUTH_SIGNIN_URL, { waitUntil: 'load', timeout: PAGE_TIMEOUT });

            console.log('------------------------------------------------------');
            console.log('               НЕОБХОДИМА АВТОРИЗАЦИЯ');
            console.log('------------------------------------------------------');
            console.log('1. Войдите в систему в открытом браузере');
            console.log('2. Дождитесь завершения процесса авторизации');
            console.log('3. Нажмите ENTER в этой консоли');
            console.log('------------------------------------------------------');

            await promptUser('После успешной авторизации нажмите ENTER для продолжения...');

            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(RETRY_DELAY);

            // Подтверждение входом считается только после реального ping токена.
            const token = await extractAuthToken(context, true);
            const raw = await pingTokenStatus(token, pingFn);

            if (isConfirmed(raw)) {
                logInfo('Авторизация подтверждена.');
                setAuthenticationStatus(true);
                await saveSession(context);
                await extractAuthToken(context, true);
                logInfo('Сессия сохранена успешно!');
                if (isPW) await page.close();
                if (!skipRestart) await restartBrowserInHeadlessMode();
                return true;
            }

            logWarn(`Авторизация не подтверждена (${raw}).`);
            setAuthenticationStatus(false);
            return false;
        } catch (error) {
            if (isPW) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Ошибка при ручной авторизации', error);
        setAuthenticationStatus(false);
        return false;
    }
}

export async function checkVerification(page) {
    try {
        // Детекция по URL/содержимому (title — лишь запасной сигнал), чтобы
        // работать и после переименования страницы в Qwen Studio.
        if (await detectVerificationOnPage(page)) {
            logWarn('Обнаружена страница верификации/анти-бот');
            if (NON_INTERACTIVE) {
                // Не блокируемся на stdin: сообщаем о верификации, вызывающий код
                // попробует reload, а при неудаче вернёт ошибку без зависания.
                logError('NON_INTERACTIVE: верификацию невозможно пройти без пользователя; запрос не будет заблокирован.');
                return true;
            }
            await promptUser('Пройдите верификацию и нажмите ENTER...');
            return true;
        }
        return false;
    } catch { return false; }
}
