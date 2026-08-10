import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { saveSession, saveAuthToken } from './session.js';
import { startManualAuthentication } from './auth.js';
import { clearPagePool, getAuthToken } from '../api/chat.js';
import { pingQwenTokenWithRetry } from '../api/qwenPing.js';
import fs from 'fs';
import path from 'path';
import { logInfo, logError, logWarn, logDebug } from '../logger/index.js';
import {
    CHAT_PAGE_URL, NAVIGATION_TIMEOUT, RETRY_DELAY, PROTOCOL_TIMEOUT,
    VIEWPORT_WIDTH, VIEWPORT_HEIGHT, USER_AGENT,
    SESSION_DIR, ACCOUNTS_DIR,
    NON_INTERACTIVE,
    BROWSER_WATCHDOG_INTERVAL, BROWSER_WATCHDOG_PROBE_TIMEOUT, BROWSER_WATCHDOG_MAX_BACKOFF,
    BROWSER_AUTH_TTL_MS
} from '../config.js';

puppeteer.use(StealthPlugin());

let browserInstance = null;
let browserContext = null;
export let isAuthenticated = false;

// Изолированные контексты аккаунтов: у каждого аккаунта свои cookies (x5sec,
// nc_sig и т.п.), и смешивать их в одном браузере нельзя — WAF видит «чужую»
// сессию и челленджит запрос. Контекст создаётся лениво для аккаунта с
// сохранённой cookie-сессией (session/accounts/<id>/cookies.json).
const accountContexts = new Map(); // accountId -> Puppeteer BrowserContext

// ─── Page helpers ────────────────────────────────────────────────────────────

// Создаёт рабочую страницу из контекста/страницы браузера. Вынесена сюда,
// чтобы chat.js и qwenPing.js делили одну реализацию без циклических импортов.
export async function getPageFromContext(context) {
    if (context && typeof context.newPage === 'function') {
        return await context.newPage();
    }

    if (context && typeof context.goto === 'function') {
        // Если передана Puppeteer Page, не переиспользуем её как рабочую:
        // создаём отдельную вкладку из того же браузера, чтобы избежать гонок
        // и случайного закрытия базовой страницы.
        if (typeof context.browser === 'function') {
            try {
                const browser = context.browser();
                if (browser && typeof browser.newPage === 'function') {
                    return await browser.newPage();
                }
            } catch (error) {
                logWarn(`Не удалось создать новую страницу из текущего контекста: ${error.message}`);
            }
        }

        if (typeof context.isClosed === 'function' && context.isClosed()) {
            throw new Error('Базовая страница браузера закрыта');
        }

        return context;
    }

    throw new Error('Неверный контекст: не страница Puppeteer, не контекст Playwright');
}

// ─── Watchdog браузера ────────────────────────────────────────────────────────
let watchdogTimer = null;
let watchdogActive = false;
let watchdogRestartFailures = 0;
let browserVisibleMode = false;
let watchdogShuttingDown = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isBrowserHealthy() {
    if (!browserInstance) return false;
    try {
        if (typeof browserInstance.isConnected === 'function' && !browserInstance.isConnected()) return false;
        const proc = typeof browserInstance.process === 'function' ? browserInstance.process() : null;
        if (proc && proc.exitCode !== null) return false; // Chromium упал (OOM/kill)
    } catch {
        return false;
    }
    if (!browserContext) return false;
    try {
        if (typeof browserContext.isClosed === 'function' && browserContext.isClosed()) return false;
    } catch {
        return false;
    }
    return true;
}

async function isBrowserFullyHealthy() {
    if (!isBrowserHealthy()) return false;
    // Лёгкий probe базовой страницы: если рендерер завис или CDP оборвался,
    // evaluate упадёт/зависнет — считаем браузер нездоровым.
    try {
        await Promise.race([
            browserContext.evaluate(() => document.readyState),
            new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), BROWSER_WATCHDOG_PROBE_TIMEOUT))
        ]);
        return true;
    } catch {
        return false;
    }
}

async function restartBrowserForWatchdog() {
    logWarn('Watchdog: браузер не отвечает, перезапускаем...');
    await shutdownBrowser();
    // Всегда перезапускаем в headless: API-запросы не нуждаются в видимом окне,
    // а интерактивная авторизация — отдельный пользовательский процесс, который
    // не должен блокироваться watchdog-перезапуском (иначе — ожидание ENTER).
    const ok = await initBrowser(false);
    if (ok) {
        logInfo('Watchdog: браузер успешно перезапущен');
    } else {
        logError('Watchdog: не удалось перезапустить браузер; следующая попытка с увеличенным интервалом');
    }
    return ok;
}

function scheduleWatchdogTick(delayMs) {
    if (watchdogShuttingDown) return;
    watchdogTimer = setTimeout(async () => {
        if (watchdogShuttingDown) return;
        let nextDelay = delayMs;
        if (watchdogActive || !browserInstance) {
            scheduleWatchdogTick(nextDelay);
            return;
        }
        const healthy = await isBrowserFullyHealthy();
        if (healthy) {
            watchdogRestartFailures = 0;
            nextDelay = BROWSER_WATCHDOG_INTERVAL;
        } else {
            watchdogActive = true;
            try {
                const ok = await restartBrowserForWatchdog();
                watchdogRestartFailures = ok ? 0 : watchdogRestartFailures + 1;
                nextDelay = ok
                    ? BROWSER_WATCHDOG_INTERVAL
                    : Math.min(BROWSER_WATCHDOG_INTERVAL * Math.pow(2, watchdogRestartFailures), BROWSER_WATCHDOG_MAX_BACKOFF);
            } finally {
                watchdogActive = false;
            }
        }
        scheduleWatchdogTick(nextDelay);
    }, delayMs);
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}

export function startBrowserWatchdog() {
    if (watchdogTimer) return;
    watchdogShuttingDown = false;
    logInfo(`Watchdog браузера запущен (интервал ${Math.round(BROWSER_WATCHDOG_INTERVAL / 1000)}с)`);
    scheduleWatchdogTick(BROWSER_WATCHDOG_INTERVAL);
}

export function stopBrowserWatchdog() {
    watchdogShuttingDown = true;
    if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
    }
}

export async function initBrowser(visibleMode = true, skipManualRestart = false) {
    if (browserInstance) return true;

    browserVisibleMode = visibleMode;
    logInfo('Инициализация браузера с Puppeteer Stealth...');
    try {
        browserInstance = await puppeteer.launch({
            headless: !visibleMode,
            slowMo: visibleMode ? 30 : 0,
            executablePath: process.env.CHROME_PATH || undefined,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage', '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
                '--start-maximized', '--disable-infobars',
                '--disable-extensions', '--disable-gpu',
                '--no-first-run', '--no-default-browser-check',
                '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list'
            ],
            defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
            protocolTimeout: PROTOCOL_TIMEOUT,
            ignoreHTTPSErrors: true
        });

        const pages = await browserInstance.pages();
        const page = pages.length > 0 ? pages[0] : await browserInstance.newPage();

        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [{ 0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }, description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1, name: 'Chrome PDF Plugin' }]
            });
            Object.defineProperty(navigator, 'connection', {
                get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false })
            });
            if (!navigator.getBattery) {
                navigator.getBattery = () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 });
            }

            const originalAddEventListener = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (type, listener, options) {
                if (type === 'mousemove' || type === 'mousedown' || type === 'mouseup') {
                    const wrappedListener = function (event) { setTimeout(() => listener.call(this, event), Math.random() * 3); };
                    return originalAddEventListener.call(this, type, wrappedListener, options);
                }
                return originalAddEventListener.call(this, type, listener, options);
            };

            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function (type) {
                const context = this.getContext('2d');
                if (context) {
                    const imageData = context.getImageData(0, 0, this.width, this.height);
                    const data = imageData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        const noise = Math.floor(Math.random() * 5) - 2;
                        data[i] = Math.max(0, Math.min(255, data[i] + noise));
                        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
                        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
                    }
                    context.putImageData(imageData, 0, 0);
                }
                return originalToDataURL.apply(this, arguments);
            };
        });

        browserContext = page;
        logInfo('Браузер инициализирован с максимальной защитой от обнаружения');

        if (!visibleMode) {
            // Qwen WAF пропускает API-запросы только с cookies сессии (x5sec и др.):
            // без них headless-запросы блокируются анти-ботом. Подгружаем
            // сохранённые при ручной авторизации cookies в headless-браузер.
            await loadSessionCookiesIntoBrowser(browserInstance);
        }

        if (visibleMode) {
            await startManualAuthenticationPuppeteer(page, skipManualRestart);
        }
        // loadSessionPuppeteer removed — was dead code (always returned false)

        return true;
    } catch (error) {
        logError('Ошибка при инициализации браузера', error);
        return false;
    }
}

async function saveSessionPuppeteer(page) {
    try {
        const cookies = await page.cookies();
        const sessionDir = path.join(process.cwd(), SESSION_DIR, ACCOUNTS_DIR);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        const accountId = `acc_${Date.now()}`;
        const accountDir = path.join(sessionDir, accountId);
        if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });

        fs.writeFileSync(path.join(accountDir, 'cookies.json'), JSON.stringify(cookies, null, 2));
        logInfo(`Cookies сохранены для аккаунта ${accountId}`);
        return accountId;
    } catch (error) {
        logError('Ошибка при сохранении сессии', error);
        return null;
    }
}

// Загружает cookies ОДНОГО аккаунта (session/accounts/<id>/cookies.json) в
// указанный контекст браузера. Возвращает число загруженных cookies.
async function loadAccountCookiesIntoContext(context, accountId) {
    const cookieFile = path.join(process.cwd(), SESSION_DIR, ACCOUNTS_DIR, accountId, 'cookies.json');
    if (!fs.existsSync(cookieFile)) return 0;
    let cookies = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        for (const c of Array.isArray(parsed) ? parsed : []) {
            if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') continue;
            cookies.push({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: typeof c.path === 'string' ? c.path : '/',
                secure: Boolean(c.secure),
                httpOnly: Boolean(c.httpOnly),
                sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
                expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1
            });
        }
    } catch { /* битый файл cookies — пропускаем */ }
    if (cookies.length === 0) return 0;
    if (typeof context.setCookie === 'function') {
        await context.setCookie(...cookies);
    }
    return cookies.length;
}

/**
 * Контекст браузера для конкретного managed-аккаунта (session/accounts/<id>):
 * отдельный инкогнито-контекст с cookies ТОЛЬКО этого аккаунта. Раньше все
 * аккаунты жили в одном браузере и их cookies перемешивались — WAF видел
 * токен одного аккаунта с cookies другого и челленджил всё подряд.
 *
 * Возвращает изолированный BrowserContext (у него есть newPage()), либо общий
 * контекст, если у аккаунта нет сохранённой cookie-сессии или браузер недоступен.
 */
export async function getAccountBrowserContext(accountId) {
    if (!accountId) return browserContext;
    const existing = accountContexts.get(accountId);
    if (existing) return existing;
    if (!browserInstance || typeof browserInstance.createBrowserContext !== 'function') return browserContext;
    const cookieFile = path.join(process.cwd(), SESSION_DIR, ACCOUNTS_DIR, accountId, 'cookies.json');
    if (!fs.existsSync(cookieFile)) return browserContext;
    try {
        const context = await browserInstance.createBrowserContext();
        const loaded = await loadAccountCookiesIntoContext(context, accountId);
        accountContexts.set(accountId, context);
        if (loaded > 0) {
            logInfo(`Аккаунт ${accountId}: изолированный контекст, загружено ${loaded} cookies`);
        } else {
            logWarn(`Аккаунт ${accountId}: изолированный контекст без cookies (файл пуст)`);
        }
        return context;
    } catch (e) {
        logWarn(`Аккаунт ${accountId}: не удалось создать изолированный контекст (${e.message?.slice(0, 80)}) — используем общий`);
        return browserContext;
    }
}

// Загружает сохранённые cookies сессий (session/accounts/*/cookies.json) в
// браузер. При ручной авторизации cookies НЕ подмешиваем — пользователь входит
// заново и получает свежую сессию.
async function loadSessionCookiesIntoBrowser(browser) {
    try {
        const accountsDir = path.join(process.cwd(), SESSION_DIR, ACCOUNTS_DIR);
        if (!fs.existsSync(accountsDir)) return;
        const cookies = [];
        for (const dirName of fs.readdirSync(accountsDir)) {
            const cookieFile = path.join(accountsDir, dirName, 'cookies.json');
            if (!fs.existsSync(cookieFile)) continue;
            try {
                const parsed = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
                for (const c of Array.isArray(parsed) ? parsed : []) {
                    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') continue;
                    cookies.push({
                        name: c.name,
                        value: c.value,
                        domain: c.domain,
                        path: typeof c.path === 'string' ? c.path : '/',
                        secure: Boolean(c.secure),
                        httpOnly: Boolean(c.httpOnly),
                        sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
                        expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1
                    });
                }
            } catch { /* битый файл cookies — пропускаем */ }
        }
        if (cookies.length > 0) {
            await browser.setCookie(...cookies);
            logInfo(`Загружено ${cookies.length} cookies сессий в headless-браузер`);
        }
    } catch (error) {
        logWarn(`Не удалось загрузить cookies сессий: ${error.message}`);
    }
}

const LOGIN_POLL_MS = 5000;
// Сразу после открытия страницы в storage уже лежит гостевой JWT Qwen Studio.
// Пинговать его до логина бессмысленно: получим WAF/отказ и будем крутить
// цикл открытия вкладок. Первые LOGIN_PING_GRACE_MS просто ждём (пользователь
// входит), потом пингуем только новые значения токена.
const LOGIN_PING_GRACE_MS = 20000;
// Если анти-бот (WAF) блокирует ping'и, бесконечно крутить автопроверку
// бессмысленно: гостевые JWT меняются при каждой навигации. После этого числа
// неудачных подтверждений продолжаем с токеном из браузера (как при ENTER)
// с предупреждением.
const MAX_UNCONFIRMED_LOGIN_PINGS = 3;

// Читает токен из localStorage/sessionStorage страницы. Общий код для ручной
// авторизации и автодетекта входа.
async function readTokenFromStorage(page) {
    try {
        return await page.evaluate(() => {
            const directKeys = ['token', 'auth_token', 'access_token', 'id_token', 'qwen_token'];
            for (const key of directKeys) {
                const value = localStorage.getItem(key) || sessionStorage.getItem(key);
                if (value) return value;
            }
            const jwtLike = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
            for (const storage of [localStorage, sessionStorage]) {
                for (let i = 0; i < storage.length; i += 1) {
                    const value = storage.getItem(storage.key(i)) || '';
                    const match = value.match(jwtLike);
                    if (match) return match[0];
                }
            }
            return null;
        });
    } catch (error) {
        logWarn(`Не удалось прочитать localStorage/sessionStorage: ${error.message}`);
        return null;
    }
}

// Ждёт либо появления токена в storage, подтверждённого реальным ping'ом
// (Qwen Studio выдаёт гостевые JWT анонимам — «токен есть» ещё не значит
// «вошли»), либо принудительного ENTER в консоли. Возвращает подтверждённый
// токен, либо null, если пользователь нажал ENTER.
async function waitForLoginOrEnter(page) {
    const pingedTokens = new Set();
    let finished = false;

    const onData = (key) => {
        if (key === '\n' || key === '\r' || key.charCodeAt(0) === 13) {
            finished = true;
        }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);

    let confirmedToken = null;
    let unconfirmedPings = 0;
    const startedAt = Date.now();
    try {
        while (!finished) {
            const token = await readTokenFromStorage(page);
            const inGrace = Date.now() - startedAt < LOGIN_PING_GRACE_MS;
            if (token && !pingedTokens.has(token) && !inGrace) {
                pingedTokens.add(token);
                const raw = await pingQwenTokenWithRetry(token);
                if (raw === 'OK' || raw === 'RATELIMIT') {
                    confirmedToken = token;
                    finished = true;
                } else {
                    unconfirmedPings++;
                    logDebug(`Ожидание входа: токен не подтверждён (${raw}), продолжаем ждать...`);
                    if (unconfirmedPings >= MAX_UNCONFIRMED_LOGIN_PINGS) {
                        logWarn('Анти-бот (WAF) блокирует автопроверку токена. Продолжаем с токеном из браузера. Если вы НЕ вошли в аккаунт — остановите скрипт (Ctrl+C) и повторите.');
                        finished = true;
                    }
                }
            }
            if (!finished) await delay(LOGIN_POLL_MS);
        }
    } finally {
        try {
            process.stdin.pause();
            process.stdin.removeListener('data', onData);
        } catch { /* stdin может быть уже закрыт */ }
    }
    return confirmedToken;
}

async function startManualAuthenticationPuppeteer(page, skipManualRestart) {
    if (NON_INTERACTIVE) {
        logError('NON_INTERACTIVE: ручная авторизация в видимом браузере недоступна. Запустите авторизацию в интерактивном режиме.');
        throw new Error('NON_INTERACTIVE: ручная авторизация невозможна');
    }
    try {
        logInfo('Открытие страницы для ручной авторизации...');
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT });
        await delay(5000);

        console.log('------------------------------------------------------');
        console.log('               НЕОБХОДИМА АВТОРИЗАЦИЯ');
        console.log('------------------------------------------------------');
        console.log('Пожалуйста, выполните следующие действия:');
        console.log('1. Войдите в систему в открытом браузере');
        console.log('2. ВАЖНО: Двигайте мышью естественно, не спешите');
        console.log('3. Если появится слайдер капчи - решите её медленно');
        console.log('4. Дождитесь полной загрузки главной страницы');
        console.log('------------------------------------------------------');
        console.log('Окно закроется САМО, как только вход будет обнаружен и токен');
        console.log('подтверждён (обычно через 5-30 секунд после логина).');
        console.log('Можно нажать ENTER в консоли, чтобы продолжить сразу.');

        const confirmedToken = await waitForLoginOrEnter(page);
        if (confirmedToken) {
            logInfo('Вход обнаружен автоматически: токен подтверждён ping\'ом.');
        } else {
            logInfo('Получено подтверждение, продолжаем...');
        }

        let cookies = [];
        try {
            cookies = await page.cookies();
            logInfo(`Сохранено ${cookies.length} cookies`);
        } catch (error) {
            logWarn(`Не удалось прочитать cookies после ручной авторизации: ${error.message}`);
        }

        let sessionToken = confirmedToken || await readTokenFromStorage(page);
        if (sessionToken) {
            logInfo('Токен найден и будет сохранен');
            saveAuthToken(sessionToken);
        } else {
            logWarn('Токен не найден в localStorage/sessionStorage');
            logInfo('Попытка извлечь токен из cookies...');
            const tokenCookie = cookies.find(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('auth'));
            if (tokenCookie) {
                logInfo(`Токен найден в cookie: ${tokenCookie.name}`);
                saveAuthToken(tokenCookie.value);
                sessionToken = tokenCookie.value;
            }
        }

        // Qwen Studio выдаёт гостевые JWT анонимам: наличие токена само по себе
        // вход не доказывает. «Авторизован» ставится только после подтверждения
        // токена реальным ping'ом.
        if (sessionToken && sessionToken !== confirmedToken) {
            const raw = await pingQwenTokenWithRetry(sessionToken);
            if (raw === 'OK' || raw === 'RATELIMIT') {
                logInfo(`Сессия подтверждена ping'ом (${raw}).`);
                setAuthenticationStatus(true);
            } else {
                logWarn(`Токен не подтверждён (${raw}): статус авторизации НЕ ставится. Если вы вошли — повторите авторизацию или дождитесь повторной проверки.`);
                setAuthenticationStatus(false);
            }
        } else if (sessionToken) {
            logInfo('Сессия подтверждена ping\'ом (OK).');
            setAuthenticationStatus(true);
        } else {
            logWarn('Токен авторизации не найден после входа.');
            setAuthenticationStatus(false);
        }

        try {
            const accountId = await saveSessionPuppeteer(page);
            if (accountId) logInfo(`Сессия сохранена с ID: ${accountId}`);
        } catch (error) {
            logWarn(`Не удалось сохранить cookies-сессию: ${error.message}`);
        }

        logInfo('Ручная авторизация завершена');

        if (!skipManualRestart) await restartBrowserInHeadlessMode();
    } catch (error) {
        logError('Ошибка при ручной авторизации', error);
        throw error;
    }
}

export async function restartBrowserInHeadlessMode() {
    logInfo('Перезапуск браузера в фоновом режиме...');
    const token = getAuthToken();
    if (token) { logDebug('Сохранение токена...'); saveAuthToken(token); await delay(1000); }
    await shutdownBrowser();
    await delay(RETRY_DELAY);
    const success = await initBrowser(false);
    logInfo(success ? 'Браузер перезапущен в фоновом режиме' : 'Ошибка при перезапуске браузера');
}

export async function shutdownBrowser() {
    try {
        try { await clearPagePool(); } catch (e) { logError('Ошибка при очистке пула страниц', e); }
        // Изолированные контексты аккаунтов закрываем ДО browserInstance.close().
        for (const [accountId, context] of accountContexts) {
            try {
                await context.close();
            } catch (e) {
                logWarn(`Ошибка при закрытии контекста аккаунта ${accountId}: ${e.message?.slice(0, 80)}`);
            }
        }
        accountContexts.clear();
        if (browserInstance) {
            try {
                const pages = await browserInstance.pages();
                for (const page of pages) await page.close().catch(() => {});
                await browserInstance.close();
            } catch (e) { logError('Ошибка при закрытии браузера', e); }
        }
        browserContext = null;
        browserInstance = null;
        logInfo('Браузер закрыт');
    } catch (error) {
        logError('Ошибка при завершении работы браузера', error);
    }
}

export function getBrowserContext() { return browserContext; }

// True, когда браузер запущен в видимом режиме (ручная авторизация, верификация).
// В этом режиме нельзя создавать дополнительные вкладки под капотом: пользователь
// видит их открытие/закрытие, а WAF считает такое поведение подозрительным.
export function isBrowserVisibleMode() { return browserVisibleMode; }

// ─── Кэш-флаг авторизации с TTL ───────────────────────────────────────────────
// isAuthenticated подтверждается ping'ом токена и «протухает» через
// BROWSER_AUTH_TTL_MS: после истечения getAuthenticationStatus() возвращает
// false, и следующая проверка (checkAuthentication) перепроверит сессию,
// вместо того чтобы вечно считать истёкшую сессию живой.
let authConfirmedAt = 0;

/**
 * Чистая проверка «подтверждена ли сессия» по времени подтверждения (для тестов).
 * ttlMs <= 0 — TTL отключён: подтверждение не протухает.
 */
export function isAuthConfirmed(confirmedAt, ttlMs, now = Date.now()) {
    if (confirmedAt <= 0) return false;
    return ttlMs <= 0 || (now - confirmedAt) <= ttlMs;
}

export function setAuthenticationStatus(status) {
    isAuthenticated = Boolean(status);
    authConfirmedAt = status ? Date.now() : 0;
}

export function getAuthenticationStatus() {
    if (!isAuthenticated) return false;
    return isAuthConfirmed(authConfirmedAt, BROWSER_AUTH_TTL_MS);
}
