import { getBrowserContext, getAccountBrowserContext, getPageFromContext, getAuthenticationStatus, setAuthenticationStatus, isBrowserVisibleMode } from '../browser/browser.js';
import { checkAuthentication, checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { withOperationGuard } from '../utils/operationGuard.js';
import { buildQwenRequestHeaders, classifyQwenError } from './qwenPing.js';
import { isAntiBotBody } from '../utils/verificationMarkers.js';
import { extractPunishUrl, solveX5secChallenge } from '../browser/x5secSolver.js';
import { saveAuthToken, saveSession } from '../browser/session.js';
import {
    getAvailableToken,
    getAvailableTokenById,
    hasValidTokens,
    markInvalidByToken,
    markRateLimitedByToken,
    recordOp,
    isOpsOverLimit
} from './tokenManager.js';
import {
    createAccountAffinityRegistry,
    resolveChatRequestContext,
    snapshotAccountToken
} from './accountAffinity.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logWarn, logDebug, logRaw } from '../logger/index.js';
import crypto from 'crypto';
import {
    CHAT_API_URL, CREATE_CHAT_URL, CHAT_PAGE_URL, TASK_STATUS_URL,
    PAGE_TIMEOUT, RETRY_DELAY, PAGE_POOL_SIZE,
    DEFAULT_MODEL, MAX_RETRY_COUNT, RATE_LIMIT_DEFAULT_HOURS,
    TASK_POLL_MAX_ATTEMPTS, TASK_POLL_INTERVAL,
    NON_INTERACTIVE, PAGE_EVALUATE_TIMEOUT, POOL_PROBE_TIMEOUT,
    QWEN_OPS_PER_HOUR, QWEN_OPS_WINDOW_MS, QWEN_OPS_BAN_HOURS, QWEN_BAN_DETECT_MS, QWEN_WAF_RECOVERY_MS
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '..', 'AvailableModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let browserAuthToken = null;
let availableModels = null;
let authKeys = null;
let browserTokenCooldown = null;
const resourceAccountAffinity = createAccountAffinityRegistry();
const chatAccountAffinity = Object.freeze({
    get: chatId => resourceAccountAffinity.get(buildAffinityKey('chat', chatId)),
    forget: chatId => resourceAccountAffinity.forget(buildAffinityKey('chat', chatId))
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isBrowserAccountId(accountId) {
    return typeof accountId === 'string' && accountId.startsWith('browser:');
}

export function getManagedAccountId(storedAccountId) {
    if (storedAccountId === null || storedAccountId === undefined) return null;
    const normalized = String(storedAccountId).trim();
    return normalized ? `managed:${encodeURIComponent(normalized)}` : null;
}

function getStoredManagedAccountId(accountId) {
    if (typeof accountId !== 'string' || !accountId.startsWith('managed:')) return null;
    try {
        return decodeURIComponent(accountId.slice('managed:'.length)) || null;
    } catch {
        return null;
    }
}

function snapshotManagedToken(tokenObj) {
    const managedId = getManagedAccountId(tokenObj?.id);
    return snapshotAccountToken({ id: managedId, token: tokenObj?.token });
}

export function getBrowserFetchCredentials() {
    // Все запросы выполняются из страниц chat.qwen.ai: 'same-origin' отправляет
    // cookies сессии, без которых WAF Qwen блокирует API-запросы
    // (FAIL_SYS_USER_VALIDATE / _____tmd_____/punish). Cookies в headless-браузер
    // подгружаются из session/accounts/*/cookies.json при инициализации.
    return 'same-origin';
}

function snapshotBrowserToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const fingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    return snapshotAccountToken({ id: `browser:${fingerprint}`, token });
}

function tokenFingerprint(token) {
    return typeof token === 'string' && token
        ? crypto.createHash('sha256').update(token).digest('hex')
        : null;
}

export function createBrowserTokenCooldown(token, hours = 24, now = Date.now()) {
    const fingerprint = tokenFingerprint(token);
    if (!fingerprint) return null;
    const normalizedHours = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : 24;
    return Object.freeze({
        fingerprint,
        resetAt: now + normalizedHours * 60 * 60 * 1000
    });
}

export function isBrowserTokenCooldownActive(cooldown, token, now = Date.now()) {
    if (!cooldown || cooldown.fingerprint !== tokenFingerprint(token)) return false;
    return Number(cooldown.resetAt) > now;
}

function browserTokenIsRateLimited(token, now = Date.now()) {
    if (!browserTokenCooldown) return false;
    if (!isBrowserTokenCooldownActive(browserTokenCooldown, token, now)) {
        browserTokenCooldown = null;
        return false;
    }
    return true;
}

function markBrowserTokenRateLimited(token, hours) {
    browserTokenCooldown = createBrowserTokenCooldown(token, hours);
}

export async function hasAlternativeAccount(
    currentTokenObj,
    { hasManagedAccount, resolveBrowserAccount }
) {
    if (typeof hasManagedAccount !== 'function' || typeof resolveBrowserAccount !== 'function') {
        throw new TypeError('hasManagedAccount and resolveBrowserAccount are required');
    }
    if (hasManagedAccount()) return true;
    const browserTokenObj = snapshotAccountToken(await resolveBrowserAccount());
    return Boolean(browserTokenObj) && browserTokenObj.token !== currentTokenObj?.token;
}

async function canRetryWithAnotherAccount(currentTokenObj, browserContext) {
    return hasAlternativeAccount(currentTokenObj, {
        hasManagedAccount: hasValidTokens,
        resolveBrowserAccount: () => resolveBrowserToken(browserContext)
    });
}

export function buildQwenCompletionUrl(apiUrl, chatId) {
    if (!chatId) return apiUrl;
    const url = new URL(apiUrl, CHAT_PAGE_URL);
    if (!url.searchParams.has('chat_id')) {
        url.searchParams.set('chat_id', chatId);
    }
    return url.toString();
}

// Страницы, уничтоженные после таймаута/отмены. releasePage не должен
// возвращать их в пул, даже если page.close() ещё выполняется.
const disposedPages = new WeakSet();

// Контекст, из которого создана страница (для изоляции аккаунтов: страницу
// одного аккаунта нельзя отдавать другому — у них разные cookies).
const pageContextMap = new WeakMap();

// Идентичность cookie-контекста запрошенного объекта: для Puppeteer Page — её
// BrowserContext, для BrowserContext — сам объект, для моков/тестов — как есть.
export function contextIdentity(context) {
    try {
        if (context && typeof context.browserContext === 'function') return context.browserContext();
    } catch { /* не Puppeteer */ }
    return context;
}

// Контекст браузера для запросов конкретного managed-аккаунта. У аккаунтов из
// tokens.json (id вида managed:acc_...) свои cookies — используем изолированный
// контекст, чтобы WAF видел консистентную сессию, а не «токен A + cookies B».
export async function resolveRequestBrowserContext(accountId) {
    const storedId = getStoredManagedAccountId(accountId);
    if (!storedId) return getBrowserContext();
    return (await getAccountBrowserContext(storedId)) || getBrowserContext();
}

export const pagePool = {
    pages: [],
    maxSize: PAGE_POOL_SIZE,

    async getPage(context) {
        const baseContext = getBrowserContext();
        const wantCtx = contextIdentity(context);
        // Ограничиваем число просмотров пула: страницы чужих контекстов
        // возвращаем обратно (они нужны своему аккаунту), а не выбрасываем.
        const poolSize = this.pages.length;
        let scanned = 0;
        while (this.pages.length > 0 && scanned < poolSize) {
            const page = this.pages.pop();
            scanned++;
            try {
                if (page === baseContext) {
                    logWarn('Базовая страница не должна быть в пуле, пропускаем');
                    continue;
                }
                if (disposedPages.has(page)) {
                    logWarn('Страница из пула уничтожена, пропускаем');
                    continue;
                }
                if (page.isClosed()) {
                    logWarn('Страница из пула закрыта, пропускаем');
                    continue;
                }
                const pageCtx = pageContextMap.get(page);
                if (wantCtx && pageCtx && pageCtx !== wantCtx) {
                    // Страница другого аккаунта (другие cookies) — оставляем в пуле.
                    this.pages.push(page);
                    continue;
                }
                await withOperationGuard(
                    page.evaluate(() => document.readyState),
                    { timeoutMs: POOL_PROBE_TIMEOUT, label: 'Проверка страницы из пула' }
                );
                return page;
            } catch (e) {
                logWarn(`Страница из пула протухла (${e.message?.substring(0, 60)}), создаём новую`);
                if (page !== baseContext) {
                    try { await page.close(); } catch { /* already dead */ }
                }
            }
        }

        const newPage = await getPageFromContext(context);
        pageContextMap.set(newPage, contextIdentity(newPage) || wantCtx || context);
        await newPage.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

        if (!browserAuthToken) {
            try {
                browserAuthToken = await newPage.evaluate(() => localStorage.getItem('token'));
                logInfo('Токен авторизации получен из браузера');
                if (browserAuthToken) {
                    saveAuthToken(browserAuthToken);
                }
            } catch (e) {
                logError('Ошибка при получении токена авторизации', e);
            }
        }

        return newPage;
    },

    releasePage(page) {
        try {
            if (page.isClosed()) return;
        } catch { return; }
        if (disposedPages.has(page)) return;

        const baseContext = getBrowserContext();
        if (page === baseContext) {
            // Базовую страницу держим отдельно от пула.
            return;
        }

        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(e => logError('Ошибка при закрытии страницы', e));
        }
    },

    // Закрывает страницу насовсем (не возвращает в пул). Используется, когда
    // на странице мог остаться незавершённый fetch после таймаута/отмены —
    // переиспользование такой страницы рискованно.
    disposePage(page) {
        const baseContext = getBrowserContext();
        if (page === baseContext) return;
        disposedPages.add(page);
        try {
            if (!page.isClosed()) {
                page.close().catch(e => logError('Ошибка при закрытии страницы после таймаута', e));
            }
        } catch { /* already dead */ }
    },

    async clear() {
        const baseContext = getBrowserContext();
        for (const page of this.pages) {
            if (page === baseContext) continue;
            try { await page.close(); } catch (e) {
                logError('Ошибка при закрытии страницы в пуле', e);
            }
        }
        this.pages = [];
    }
};

// ─── Task polling ────────────────────────────────────────────────────────────

export async function pollTaskStatus(taskId, page, token, maxAttempts = TASK_POLL_MAX_ATTEMPTS, interval = TASK_POLL_INTERVAL, credentials = 'omit', signal = null) {
    logInfo(`Начинаем опрос статуса задачи: ${taskId}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
            logWarn(`Опрос задачи ${taskId} отменён клиентом`);
            return { success: false, status: 'aborted', error: 'Запрос отменён клиентом' };
        }
        try {
            const statusUrl = `${TASK_STATUS_URL}/${taskId}`;

            const result = await withOperationGuard(
                page.evaluate(async (data) => {
                try {
                    const response = await fetch(data.url, {
                        method: 'GET',
                        credentials: data.credentials,
                        headers: {
                            'Authorization': `Bearer ${data.token}`,
                            'Accept': 'application/json'
                        }
                    });
                    if (!response.ok) {
                        return { success: false, status: response.status, error: await response.text() };
                    }
                    return { success: true, data: await response.json() };
                } catch (e) {
                    return { success: false, error: e.toString() };
                }
                }, { url: statusUrl, token, credentials }),
                {
                    timeoutMs: PAGE_EVALUATE_TIMEOUT,
                    signal,
                    label: `Опрос задачи ${taskId}`,
                    onAbort: () => pagePool.disposePage(page)
                }
            );

            if (!result.success) {
                logWarn(`Ошибка при проверке статуса (попытка ${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const taskData = result.data;
            const taskStatus = taskData.task_status || taskData.status || 'unknown';
            logDebug(`Статус задачи (${attempt}/${maxAttempts}): ${taskStatus}`);

            if (taskStatus === 'completed' || taskStatus === 'success') {
                logInfo('Задача завершена успешно');
                return { success: true, status: 'completed', data: taskData };
            }

            if (taskStatus === 'failed' || taskStatus === 'error') {
                logError('Задача завершилась с ошибкой');
                return { success: false, status: 'failed', error: taskData.error || taskData.message || 'Задача завершилась ошибкой', data: taskData };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Ошибка при опросе задачи (попытка ${attempt}/${maxAttempts})`, error);
            if (error?.code === 'ETIMEDOUT' || error?.code === 'ABORTED') {
                logWarn(`Опрос задачи ${taskId} остановлен (${error.code})`);
                return { success: false, status: 'timeout', error: error.message || 'Опрос задачи остановлен' };
            }
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Превышен лимит попыток (${maxAttempts}) для задачи ${taskId}`);
    return { success: false, status: 'timeout', error: 'Превышен таймаут polling задачи' };
}

// ─── Token extraction ────────────────────────────────────────────────────────

export async function extractAuthToken(context, forceRefresh = false) {
    if (browserAuthToken && !forceRefresh) return browserAuthToken;

    try {
        // В видимом режиме (ручная авторизация) НЕ создаём новую вкладку: базовый
        // контекст уже находится на chat.qwen.ai с токеном в storage — читаем его
        // напрямую без навигации. Так окно не дёргается открытием/закрытием
        // вкладки после завершения авторизации.
        const reuseBase = isBrowserVisibleMode() && context && typeof context.evaluate === 'function';
        const page = reuseBase ? context : await getPageFromContext(context);
        const shouldClosePage = !reuseBase && page !== context;
        try {
            if (!reuseBase) {
                await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
                await delay(RETRY_DELAY);
            }

            const newToken = await withOperationGuard(
                page.evaluate(async () => {
                    function findTokenInStorage(storage) {
                        const directKeys = ['token', 'auth_token', 'access_token', 'id_token', 'qwen_token'];
                        for (const key of directKeys) {
                            const value = storage.getItem(key);
                            if (value) return value;
                        }
                        const jwtLike = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
                        for (let i = 0; i < storage.length; i += 1) {
                            const value = storage.getItem(storage.key(i)) || '';
                            const match = value.match(jwtLike);
                            if (match) return match[0];
                        }
                        return null;
                    }

                    return findTokenInStorage(localStorage) || findTokenInStorage(sessionStorage);
                }),
                { timeoutMs: PAGE_EVALUATE_TIMEOUT, label: 'Извлечение токена авторизации' }
            );
            if (shouldClosePage) await page.close();

            if (newToken) {
                browserAuthToken = newToken;
                logInfo('Токен авторизации успешно извлечен');
                saveAuthToken(browserAuthToken);
                return browserAuthToken;
            }
            logError('Токен авторизации не найден в браузере');
            return null;
        } catch (error) {
            if (shouldClosePage) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Ошибка при извлечении токена авторизации', error);
        return null;
    }
}

// ─── Models & keys from files ────────────────────────────────────────────────

export function getAvailableModelsFromFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Файл с моделями не найден: ${MODELS_FILE}`);
            return [DEFAULT_MODEL];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        logInfo('===== ДОСТУПНЫЕ МОДЕЛИ =====');
        models.forEach(m => logInfo(`- ${m}`));
        logInfo('============================');
        return models;
    } catch (error) {
        logError('Ошибка при чтении файла с моделями', error);
        return [DEFAULT_MODEL];
    }
}

function getAuthKeysFromFile() {
    try {
        if (!fs.existsSync(AUTH_KEYS_FILE)) {
            const template = `# Файл API-ключей для прокси\n# --------------------------------------------\n# В этом файле перечислены токены, которые\n# прокси будет считать «действительными».\n# Один ключ — одна строка без пробелов.\n#\n# 1) Хотите ОТКЛЮЧИТЬ авторизацию целиком?\n#    Оставьте файл пустым — сервер перестанет\n#    проверять заголовок Authorization.\n#\n# 2) Хотите разрешить доступ нескольким людям?\n#    Впишите каждый ключ в отдельной строке:\n#      d35ab3e1-a6f9-4d...\n#      f2b1cd9c-1b2e-4a...\n#\n# Пустые строки и строки, начинающиеся с «#»,\n# игнорируются.`;
            try {
                fs.writeFileSync(AUTH_KEYS_FILE, template, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Создан шаблон файла ключей: ${AUTH_KEYS_FILE}`);
            } catch (e) {
                logError('Не удалось создать шаблон Authorization.txt', e);
            }
            return [];
        }
        return fs.readFileSync(AUTH_KEYS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch (error) {
        logError('Ошибка при чтении файла с ключами авторизации', error);
        return [];
    }
}

export function isValidModel(modelName) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return availableModels.includes(modelName);
}

export function getAllModels() {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return {
        models: availableModels.map(model => ({
            id: model,
            name: model,
            description: `Модель ${model}`
        }))
    };
}

export function getApiKeys() {
    if (!authKeys) authKeys = getAuthKeysFromFile();
    return authKeys;
}

// ─── sendMessage — helper functions ──────────────────────────────────────────

function validateAndPrepareMessage(message) {
    if (message === null || message === undefined) {
        return { error: 'Сообщение не может быть пустым' };
    }
    if (typeof message === 'string') return { content: message };
    if (Array.isArray(message)) {
        const isValid = message.every(item =>
            (item.type === 'text' && typeof item.text === 'string') ||
            (item.type === 'image' && typeof item.image === 'string') ||
            (item.type === 'file' && typeof item.file === 'string')
        );
        if (!isValid) return { error: 'Некорректная структура составного сообщения' };
        return { content: message };
    }
    return { error: 'Неподдерживаемый формат сообщения' };
}

async function resolveBrowserToken(browserContext) {
    if (!browserContext) return null;
    if (!getAuthenticationStatus()) {
        logInfo('Проверка авторизации...');
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) return null;
    }

    let token = browserAuthToken;
    if (token && browserTokenIsRateLimited(token)) {
        // A relogin can replace the browser token before the finite cooldown
        // expires. Refresh once so a new fingerprint is immediately usable.
        token = await extractAuthToken(browserContext, true);
    }
    if (!token) {
        logInfo('Получение токена авторизации...');
        token = await extractAuthToken(browserContext);
    }
    if (!token) return null;
    if (browserTokenIsRateLimited(token)) {
        logWarn('Browser-токен временно залимичен, пропускаем fallback');
        return null;
    }
    return snapshotBrowserToken(token);
}

async function resolveAuthToken(browserContext) {
    const tokenObj = snapshotManagedToken(await getAvailableToken());
    if (tokenObj) {
        logInfo(`Используется аккаунт: ${tokenObj.id}`);
        return tokenObj;
    }

    return resolveBrowserToken(browserContext);
}

export async function selectRequestAccount(browserContext = getBrowserContext()) {
    if (!browserContext) return null;
    return resolveAuthToken(browserContext);
}

async function resolveAccountToken(accountId, browserContext) {
    if (isBrowserAccountId(accountId)) {
        const tokenObj = await resolveBrowserToken(browserContext);
        return tokenObj?.id === accountId ? tokenObj : null;
    }
    const storedAccountId = getStoredManagedAccountId(accountId);
    return storedAccountId ? snapshotManagedToken(getAvailableTokenById(storedAccountId)) : null;
}

function buildAffinityKey(resourceType, resourceId, clientScope = null) {
    if (!resourceType || resourceId === null || resourceId === undefined) return null;
    const normalizedId = String(resourceId).trim();
    if (!normalizedId) return null;
    if (resourceType === 'file' || resourceType === 'task') {
        const normalizedScope = clientScope === null || clientScope === undefined
            ? 'unscoped'
            : String(clientScope).trim();
        if (!normalizedScope) return null;
        return `${resourceType}:${normalizedScope}:${normalizedId}`;
    }
    return `${resourceType}:${normalizedId}`;
}

export function bindResourceToAccount(resourceType, resourceId, accountId, clientScope = null) {
    const affinityKey = buildAffinityKey(resourceType, resourceId, clientScope);
    if (!affinityKey || !accountId) return false;
    const bound = resourceAccountAffinity.bind(affinityKey, accountId);
    if (!bound) {
        logWarn(`Ресурс ${resourceType}:${resourceId} уже закреплён за другим аккаунтом; привязка отклонена`);
    }
    return bound;
}

export function getResourceAccountId(resourceType, resourceId, clientScope = null) {
    return resourceAccountAffinity.get(buildAffinityKey(resourceType, resourceId, clientScope));
}

export function collectFileResourceIds(files) {
    if (!Array.isArray(files)) return [];
    const ids = new Set();
    const keys = new Set(['id', 'file', 'input_file', 'file_id', 'fileId', 'file_path', 'filePath', 'file_url', 'url']);
    const seen = new WeakSet();

    function collect(value) {
        if (typeof value === 'string' && value.trim()) {
            ids.add(value.trim());
            return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) collect(item);
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            if (keys.has(key)) collect(child);
        }
    }

    for (const file of files) {
        collect(file);
    }
    return [...ids];
}

export function collectEmbeddedFileReferences(value) {
    const references = [];
    const seen = new WeakSet();
    const fileKeys = new Set(['file', 'input_file', 'file_id', 'fileId', 'file_path', 'filePath', 'file_url']);

    function visit(item) {
        if (!item || typeof item !== 'object' || seen.has(item)) return;
        seen.add(item);
        if (Array.isArray(item)) {
            for (const child of item) visit(child);
            return;
        }

        const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
        if (type === 'file' || type === 'input_file' || Object.keys(item).some(key => fileKeys.has(key))) {
            references.push(item);
        }
        for (const child of Object.values(item)) visit(child);
    }

    visit(value);
    return references;
}

export function resolveFileAccountId(files, clientScope = null) {
    const resourceIds = collectFileResourceIds(files);
    const accountIds = new Set();
    const hasFiles = Array.isArray(files) && files.length > 0;
    let allFilesHaveKnownOwner = hasFiles && resourceIds.length > 0;

    for (const resourceId of resourceIds) {
        const accountId = getResourceAccountId('file', resourceId, clientScope);
        if (!accountId) {
            allFilesHaveKnownOwner = false;
            continue;
        }
        accountIds.add(accountId);
    }
    if (accountIds.size > 1) {
        return { error: 'Файлы принадлежат разным Qwen-аккаунтам; загрузите их заново одним аккаунтом.' };
    }
    return {
        accountId: accountIds.values().next().value || null,
        hasFiles,
        hasKnownOwner: accountIds.size === 1 && allFilesHaveKnownOwner,
        resourceIds
    };
}

export function preflightFileRequest(messageContent, files = null, clientScope = null) {
    if (files !== null && files !== undefined && !Array.isArray(files)) {
        return {
            error: 'Поле files должно быть массивом. Запрос с вложениями отклонён до выбора Qwen-аккаунта.',
            status: 400,
            invalidRequest: true
        };
    }

    const embeddedFiles = collectEmbeddedFileReferences(messageContent);
    const affinityFiles = [...(files || []), ...embeddedFiles];
    const fileAffinity = resolveFileAccountId(affinityFiles, clientScope);
    if (fileAffinity.error) {
        return { error: fileAffinity.error, status: 409, reuploadRequired: true };
    }
    if (fileAffinity.hasFiles && !fileAffinity.hasKnownOwner) {
        return {
            error: 'Не удалось определить Qwen-аккаунт прикреплённых файлов. Загрузите файлы заново перед отправкой.',
            status: 409,
            reuploadRequired: true
        };
    }
    return { fileAffinity };
}

function buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType = 't2t', size = null) {
    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();

    const isVideo = chatType === 't2v';

    const featureConfig = {
        thinking_enabled: isVideo,
        output_schema: 'phase'
    };
    if (isVideo) {
        featureConfig.research_mode = 'normal';
        featureConfig.auto_thinking = true;
        featureConfig.thinking_format = 'summary';
        featureConfig.auto_search = true;
    }

    const newMessage = {
        fid: userMessageId,
        parentId, parent_id: parentId,
        role: 'user',
        content: messageContent,
        chat_type: chatType, sub_chat_type: chatType,
        timestamp: Math.floor(Date.now() / 1000),
        user_action: 'chat',
        models: [model],
        files: files || [],
        childrenIds: [assistantChildId],
        extra: { meta: { subChatType: chatType } },
        feature_config: featureConfig
    };

    const payload = {
        stream: !isVideo,
        version: '2.1',
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        messages: [newMessage],
        model,
        parent_id: parentId,
        timestamp: Math.floor(Date.now() / 1000)
    };

    if (size) payload.size = size;

    if (systemMessage) {
        payload.system_message = systemMessage;
        logDebug(`System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? '...' : ''}`);
    }
    if (tools && Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = toolChoice || 'auto';
    }

    return payload;
}

export function isQwenAntiBotBody(body) {
    if (typeof body !== 'string') return false;
    return isAntiBotBody(body);
}

function parseNonSseCompletionBody(body) {
    if (isQwenAntiBotBody(body)) {
        return { success: false, antiBot: true, error: 'Qwen anti-bot challenge returned for Node fetch', errorBody: body };
    }

    try {
        const parsed = JSON.parse(body);
        const topLevelCode = parsed?.code;
        const nestedCode = parsed?.data?.code;
        const hasStructuredError =
            parsed?.success === false ||
            Boolean(parsed?.error) ||
            Boolean(parsed?.data?.error) ||
            Boolean(topLevelCode) ||
            Boolean(nestedCode);

        if (hasStructuredError) {
            const { kind } = classifyQwenError({ status: 0, errorBody: body, code: [topLevelCode, nestedCode] });
            return {
                success: false,
                status: kind === 'ratelimit' ? 429 : 500,
                errorBody: body
            };
        }

        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
            return { success: true, isTask: false, data: parsed };
        }
    } catch {
        // Ignore parse errors here and return a generic failure below.
    }

    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
}

async function executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk, signal = null) {
    try {
        if (!token) return { success: false, error: 'Токен авторизации не найден' };
        if (typeof fetch !== 'function') return { success: false, error: 'Fetch API is unavailable' };

        const requestUrl = buildQwenCompletionUrl(apiUrl, payload?.chat_id);

        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: buildQwenRequestHeaders(token),
            body: JSON.stringify(payload),
            signal: signal || undefined
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return {
                success: false,
                status: response.status,
                statusText: response.statusText,
                errorBody,
                antiBot: isQwenAntiBotBody(errorBody)
            };
        }

        if (payload.stream === false) {
            const jsonResponse = await response.json();
            if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
            }
            return { success: true, isTask: true, data: jsonResponse };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const body = await response.text();
            return parseNonSseCompletionBody(body);
        }

        const reader = response.body?.getReader?.();
        if (!reader) {
            const body = await response.text();
            return parseNonSseCompletionBody(body);
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let responseId = null;
        let usage = null;
        let finished = false;
        let streamError = null;
        let hasStreamedChunks = false;

        while (!finished) {
            if (signal?.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || !line.startsWith('data:')) continue;

                const jsonStr = line.substring(5).trim();
                if (!jsonStr) continue;
                if (jsonStr === '[DONE]') {
                    finished = true;
                    break;
                }

                try {
                    const chunk = JSON.parse(jsonStr);

                    if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                        streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }
                    if (chunk.error && !chunk.choices) {
                        streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }

                    if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                    if (chunk.response_id) responseId = chunk.response_id;

                    if (chunk.choices && chunk.choices[0]) {
                        const delta = chunk.choices[0].delta;
                        if (delta && delta.content) {
                            fullContent += delta.content;
                            if (typeof onChunk === 'function') {
                                onChunk(delta.content);
                                hasStreamedChunks = true;
                            }
                        }
                        if (delta && delta.status === 'finished') finished = true;
                        if (chunk.choices[0].finish_reason) finished = true;
                    }

                    if (chunk.usage) usage = chunk.usage;
                } catch {
                    // Ignore broken chunks, keep reading stream.
                }
            }
        }

        if (signal?.aborted) {
            return { success: false, error: 'Запрос отменён клиентом', aborted: true, hasStreamedChunks };
        }

        if (streamError) {
            return { success: false, ...streamError, hasStreamedChunks };
        }

        return {
            success: true,
            isTask: false,
            hasStreamedChunks,
            data: {
                id: responseId || 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: payload.model,
                choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                response_id: responseId
            }
        };
    } catch (error) {
        return { success: false, error: error.toString() };
    }
}

export function shouldReturnNodeStreamingResponse(streamedResponse, preferNodeFetch = false) {
    if (streamedResponse?.hasStreamedChunks === true) return true;
    // anti-bot челлендж (x5sec): не падаем в browser fetch (там он виснет),
    // а отдаём в handleApiError → автоматическое решение слайдера + повтор.
    if (streamedResponse?.antiBot) return true;
    return Boolean(
        streamedResponse?.success ||
        streamedResponse?.status ||
        streamedResponse?.errorBody
    );
}

async function executeApiRequest(page, apiUrl, payload, token, onChunk = null, credentials = 'omit', signal = null, options = {}) {
    if (signal?.aborted) {
        return { success: false, error: 'Запрос отменён клиентом', aborted: true };
    }
    // forceBrowserFetch: после решения x5sec-челленджа повторяем запрос через
    // браузер (cookies сессии), а не Node fetch — разблокировка привязана к сессии.
    const preferNodeFetch = options.forceBrowserFetch
        ? false
        : (String(process.env.QWEN_USE_NODE_FETCH || '').toLowerCase() === '1' || String(process.env.QWEN_USE_NODE_FETCH || '').toLowerCase() === 'true');
    if (!options.forceBrowserFetch && payload?.stream !== false && (typeof onChunk === 'function' || preferNodeFetch)) {
        const streamedResponse = await executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk, signal);

        if (signal?.aborted) {
            return { success: false, error: 'Запрос отменён клиентом', aborted: true };
        }

        if (shouldReturnNodeStreamingResponse(streamedResponse, preferNodeFetch)) {
            return streamedResponse;
        }

        logWarn(`Node-streaming недоступен (${streamedResponse.error || 'unknown error'}), fallback к browser fetch.`);
    }

    const requestBody = {
        apiUrl: buildQwenCompletionUrl(apiUrl, payload?.chat_id),
        payload,
        headers: buildQwenRequestHeaders(token),
        credentials
    };

    logDebug(`Используем токен: ${token ? 'Токен существует' : 'Токен отсутствует'}`);
    logDebug(`API URL: ${apiUrl}`);

    return withOperationGuard(
        page.evaluate(async (data) => {
        try {
            const response = await fetch(data.apiUrl, {
                method: 'POST',
                credentials: data.credentials,
                headers: data.headers,
                body: JSON.stringify(data.payload)
            });

            if (response.ok) {
                if (data.payload.stream === false) {
                    const jsonResponse = await response.json();
                    if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                        return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
                    }
                    return { success: true, isTask: true, data: jsonResponse };
                }

                const contentType = response.headers.get('content-type') || '';

                if (!contentType.includes('text/event-stream')) {
                    const body = await response.text();
                    try {
                        const parsed = JSON.parse(body);
                        const topLevelCode = parsed?.code;
                        const nestedCode = parsed?.data?.code;
                        const hasStructuredError =
                            parsed?.success === false ||
                            Boolean(parsed?.error) ||
                            Boolean(parsed?.data?.error) ||
                            Boolean(topLevelCode) ||
                            Boolean(nestedCode) ||
                            (Array.isArray(parsed?.ret) && parsed.ret.length > 0);

                        // API иногда возвращает JSON с success=false и code при HTTP 200.
                        if (hasStructuredError) {
                            const { kind } = classifyQwenError({ status: 0, errorBody: body, code: [topLevelCode, nestedCode] });
                            const antiBot = isAntiBotBody(body);
                            return {
                                success: false,
                                status: kind === 'ratelimit' ? 429 : antiBot ? 403 : 500,
                                antiBot,
                                error: antiBot ? 'Qwen anti-bot challenge returned for browser fetch' : undefined,
                                errorBody: body
                            };
                        }
                        // Валидный JSON-ответ completion (иногда Qwen возвращает так)
                        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
                            return { success: true, isTask: false, data: parsed };
                        }
                    } catch { /* not JSON, treat as unexpected */ }
                    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';
                let responseId = null;
                let usage = null;
                let finished = false;
                let streamError = null;

                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue;
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr) continue;
                        try {
                            const chunk = JSON.parse(jsonStr);

                            if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                                streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }
                            if (chunk.error && !chunk.choices) {
                                streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }

                            if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                            if (chunk.choices && chunk.choices[0]) {
                                const delta = chunk.choices[0].delta;
                                if (delta && delta.content) fullContent += delta.content;
                                if (delta && delta.status === 'finished') finished = true;
                            }
                            if (chunk.usage) usage = chunk.usage;
                        } catch { /* ignore parse errors for individual chunks */ }
                    }
                }

                if (streamError) {
                    return { success: false, ...streamError };
                }

                return {
                    success: true,
                    isTask: false,
                    data: {
                        id: responseId || 'chatcmpl-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: data.payload.model,
                        choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                        response_id: responseId
                    }
                };
            }

            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        } catch (error) {
            return { success: false, error: error.toString() };
        }
        }, requestBody),
        {
            timeoutMs: PAGE_EVALUATE_TIMEOUT,
            signal,
            label: 'Запрос к Qwen API',
            onAbort: () => pagePool.disposePage(page)
        }
    );
}

export function buildAccountSwitchRetryArgs(requestContext = {}) {
    const {
        message,
        model,
        files = null,
        tools = null,
        toolChoice = null,
        systemMessage = null,
        chatType = 't2t',
        size = null,
        waitForCompletion = true,
        retryCount = 0,
        onChunk = null,
        resetMessage = null,
        clientScope = null,
        signal = null,
        forceBrowserFetch = false
    } = requestContext;

    return [
        message,
        model,
        null,
        null,
        files,
        tools,
        toolChoice,
        systemMessage,
        chatType,
        size,
        waitForCompletion,
        retryCount + 1,
        onChunk,
        resetMessage,
        clientScope,
        signal,
        forceBrowserFetch
    ];
}

export async function retryAfterAccountSwitch(requestContext, sendMessageFn) {
    if (typeof sendMessageFn !== 'function') {
        throw new TypeError('sendMessageFn must be a function');
    }
    return sendMessageFn(...buildAccountSwitchRetryArgs(requestContext));
}

/**
 * Повтор после решения x5sec-челленджа: тот же аккаунт, тот же чат,
 * форсируем браузерный fetch (разблокировка привязана к cookies сессии).
 */
export async function retryAfterChallengeSolve(requestContext, sendMessageFn) {
    if (typeof sendMessageFn !== 'function') {
        throw new TypeError('sendMessageFn must be a function');
    }
    const args = buildAccountSwitchRetryArgs({ ...requestContext, forceBrowserFetch: true });
    // сохраняем chatId/parentId — не жжём create-chat операцию на повтор
    args[2] = requestContext.chatId ?? null;
    args[3] = requestContext.parentId ?? null;
    return sendMessageFn(...args);
}

/**
 * Похоже ли на зависший ретрай после солва (WAF пере-челленджил сессию,
 * браузерный fetch упал с сетевой ошибкой без тела)? Если да — лечим
 * пробой + повторным решением, а не парковкой.
 */
export function isWafRetryHang(response = {}, requestContext = {}) {
    if (!requestContext.forceBrowserFetch) return false;
    if (requestContext.retryCount >= MAX_RETRY_COUNT) return false;
    if (response.aborted || response.status || response.antiBot) return false;
    // «Unexpected non-SSE 200 response» на ретрае после солва — вариант
    // WAF-троттла/челленджа (тело не-SSE, не распознанное как antiBot):
    // пробуем восстановиться пробой + повторным солвом.
    if (response.error === 'Unexpected non-SSE 200 response') return true;
    if (response.errorBody) return false;
    return /network|fetch|timeout|таймаут|abort/i.test(response.error || '');
}

/**
 * Решение слайдера на ОТДЕЛЬНОЙ вкладке (не из пула): пул занят рабочими
 * запросами, и под конкуренцией солвер из пула голодает → ложная парковка.
 * Вкладку создаём и закрываем сами. В видимом режиме (ручная авторизация)
 * не создаём вкладки под капотом — авто-солв пропускаем.
 */
async function solveWafChallenge(browserContext, punishUrl, accountId = null) {
    if (isBrowserVisibleMode()) {
        logWarn('x5sec: видимый режим — не создаём вкладку для решения, авто-солв пропущен');
        return false;
    }
    let solvePage = null;
    try {
        solvePage = await getPageFromContext(browserContext);
        const solved = await solveX5secChallenge(solvePage, punishUrl);
        if (solved && accountId) {
            // После солва WAF выдаёт свежие cookies (x5sec/nc_sig), которыми
            // разблокируется сессия. Сохраняем их в сессию аккаунта, чтобы
            // разблокировка пережила рестарт и не терялась в общей куче.
            try {
                const saved = await saveSession(solvePage, accountId);
                if (saved) logInfo(`x5sec: cookies аккаунта ${accountId} обновлены после солва`);
            } catch (e) {
                logWarn(`x5sec: не удалось сохранить cookies после солва: ${e.message?.slice(0, 80)}`);
            }
        }
        return solved;
    } catch (e) {
        logWarn(`x5sec: ошибка решения на отдельной вкладке: ${e.message?.slice(0, 100)}`);
        return false;
    } finally {
        if (solvePage) await solvePage.close().catch(() => {});
    }
}

/**
 * Проба WAF-состояния аккаунта: свежий чат + completion через Node fetch.
 * Если аккаунт в x5sec-челлендже — вернёт punish HTML быстро (create-chat
 * не челленджится), и мы достаём URL капчи. Если аккаунт здоров — сгенерит
 * реальный ответ (kind: 'ok'). Свежий чат, чтобы не трогать тред реального.
 */
async function probeWafChallenge(tokenObj, model) {
    try {
        const createRes = await fetch(CREATE_CHAT_URL, {
            method: 'POST',
            headers: buildQwenRequestHeaders(tokenObj.token),
            body: JSON.stringify({ title: 'waf-probe', models: [model], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }),
            signal: AbortSignal.timeout(8000)
        });
        const createBody = await createRes.text();
        const probeChatId = JSON.parse(createBody)?.data?.id;
        if (!probeChatId) return { kind: 'failed' };

        const probePayload = buildPayloadV2('ping', model, probeChatId, crypto.randomUUID());
        const res = await executeApiRequestWithNodeStreaming(
            `${CHAT_API_URL}?chat_id=${probeChatId}`,
            probePayload,
            tokenObj.token,
            null,
            AbortSignal.timeout(8000)
        );
        if (res?.antiBot) {
            const punishUrl = extractPunishUrl(res.errorBody);
            if (punishUrl) return { kind: 'challenge', punishUrl };
            return { kind: 'failed' };
        }
        return res?.success ? { kind: 'ok' } : { kind: 'failed' };
    } catch (e) {
        logDebug(`x5sec: проба WAF упала: ${e.message?.slice(0, 80)}`);
        return { kind: 'failed' };
    }
}

/**
 * Восстановление после зависшего ретрая: подтверждаем челлендж пробой,
 * решаем слайдер повторно. kind: 'solved' | 'ok' | 'failed' | 'busy'.
 * 'busy' — другое восстановление уже идёт (не дублируем солвы).
 */
let wafRecoveryInFlight = false;

async function tryRecoverFromWafHang(tokenObj, requestContext) {
    if (wafRecoveryInFlight) return { kind: 'busy' };
    const { model, retryCount } = requestContext;
    if (retryCount >= MAX_RETRY_COUNT || !tokenObj?.token) return { kind: 'failed' };

    wafRecoveryInFlight = true;
    try {
        logInfo(`x5sec: ретрай завис — пробируем WAF-состояние аккаунта (${tokenObj.id})`);
        const probe = await probeWafChallenge(tokenObj, model);
        if (probe.kind !== 'challenge') {
            logWarn(`x5sec: проба не показала челлендж (${probe.kind})`);
            return probe;
        }

        logInfo('x5sec: WAF-челлендж подтверждён — решаем слайдер повторно');
        const solved = await solveWafChallenge(requestContext.browserContext, probe.punishUrl, tokenObj?.id);
        if (solved) {
            logInfo('x5sec: повторное решение успешно');
            return { kind: 'solved' };
        }
        logWarn('x5sec: повторное решение слайдера не удалось');
        return { kind: 'failed' };
    } finally {
        wafRecoveryInFlight = false;
    }
}

async function handleApiError(response, tokenObj, requestContext) {
    const { chatId, retryCount, fileAccountId } = requestContext;
    logRaw(JSON.stringify(response));
    logError(`Ошибка при получении ответа: ${response.error || response.statusText || `HTTP ${response.status || 'unknown'}`}`);
    if (response.errorBody) logDebug(`Тело ответа с ошибкой: ${response.errorBody}`);

    if (response.aborted) {
        logWarn(`Запрос ${chatId} отменён клиентом, не ретраим`);
        return { error: response.error || 'Запрос отменён клиентом', aborted: true, chatId };
    }

    if (response.html && response.html.includes('Verification')) {
        setAuthenticationStatus(false);
        if (NON_INTERACTIVE) {
            logWarn('Требуется верификация Qwen (anti-bot), но сервер в NON_INTERACTIVE режиме: возвращаем 503 без перезапуска браузера.');
            return { error: 'Требуется верификация (anti-bot). Сервер в NON_INTERACTIVE режиме; пройдите верификацию при интерактивном запуске.', verification: true, status: 503, chatId };
        }
        logInfo('Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...');
        await pagePool.clear();
        browserAuthToken = null;
        await shutdownBrowser();
        await initBrowser(true);
        return { error: 'Требуется верификация. Браузер запущен в видимом режиме.', verification: true, chatId };
    }

    if (classifyQwenError(response).kind === 'unauthorized') {
        logWarn(`Токен ${tokenObj?.id} недействителен (401). Удаляем и пробуем другой.`);
        chatAccountAffinity.forget(chatId);
        markInvalidByToken(tokenObj?.token);
        if (isBrowserAccountId(tokenObj?.id) || browserAuthToken === tokenObj?.token) {
            browserAuthToken = null;
            setAuthenticationStatus(false);
        }
        if (response.hasStreamedChunks) {
            return {
                error: 'Поток прерван из-за смены аккаунта; повторите запрос, чтобы начать новый чат.',
                partial: true,
                chatId
            };
        }
        if (fileAccountId) {
            return {
                error: 'Аккаунт, которому принадлежат прикреплённые файлы, недоступен. Загрузите файлы заново перед повтором.',
                chatId,
                fileAccountId,
                reuploadRequired: true
            };
        }
        if (retryCount < MAX_RETRY_COUNT && await canRetryWithAnotherAccount(tokenObj, requestContext.browserContext)) {
            logInfo('Пересоздаем чат под следующим доступным аккаунтом после ошибки авторизации');
            return retryAfterAccountSwitch(requestContext, sendMessage);
        }
        logError('Не осталось валидных токенов или исчерпаны попытки.');
        return { error: 'Все токены недействительны (401). Требуется повторная авторизация.', chatId };
    }

    if (classifyQwenError(response).kind === 'ratelimit') {
        let hours = RATE_LIMIT_DEFAULT_HOURS;
        try {
            const rateInfo = JSON.parse(response.errorBody);
            const parsedHours = Number(rateInfo.num);
            hours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : RATE_LIMIT_DEFAULT_HOURS;
        } catch { /* errorBody might not be valid JSON */ }

        markRateLimitedByToken(tokenObj?.token, hours);
        if (isBrowserAccountId(tokenObj?.id) || browserAuthToken === tokenObj?.token) {
            markBrowserTokenRateLimited(tokenObj?.token, hours);
            logWarn(`Browser-токен достиг лимита. Помечаем на ${hours}ч.`);
        } else if (tokenObj?.id) {
            logWarn(`Токен ${tokenObj.id} достиг лимита. Помечаем на ${hours}ч и пробуем другой токен...`);
        }

        chatAccountAffinity.forget(chatId);
        if (response.hasStreamedChunks) {
            return {
                error: 'Поток прерван из-за лимита аккаунта; повторите запрос, чтобы начать новый чат.',
                partial: true,
                chatId
            };
        }
        if (fileAccountId) {
            return {
                error: 'Аккаунт прикреплённых файлов достиг лимита. Загрузите файлы заново, чтобы использовать другой аккаунт.',
                chatId,
                fileAccountId,
                reuploadRequired: true
            };
        }
        if (retryCount < MAX_RETRY_COUNT && await canRetryWithAnotherAccount(tokenObj, requestContext.browserContext)) {
            logInfo('Пересоздаем чат под следующим доступным аккаунтом после rate limit');
            return retryAfterAccountSwitch(requestContext, sendMessage);
        }
        return { error: `Все токены заблокированы по лимиту (${hours}ч)`, status: 429, chatId };
    }

    if (response.antiBot) {
        // WAF/anti-bot челлендж (x5sec/_____tmd_____). Сначала пробуем решить
        // слайдер автоматически (это примитивная капча «проведите вправо»),
        // и только при неудаче паркуем аккаунт и переключаемся на другой.
        const punishUrl = extractPunishUrl(response.errorBody);
        if (punishUrl && retryCount < MAX_RETRY_COUNT) {
            logInfo(`x5sec: anti-bot челлендж (${tokenObj?.id}) — пробуем решить слайдер автоматически`);
            const solved = await solveWafChallenge(requestContext.browserContext, punishUrl, tokenObj?.id);
            if (solved) {
                logInfo('x5sec: слайдер решён — повторяем запрос на том же аккаунте');
                return retryAfterChallengeSolve(requestContext, sendMessage);
            }
            logWarn(`x5sec: не удалось решить челлендж (${tokenObj?.id}) — паркуем аккаунт`);
        } else if (!punishUrl) {
            logDebug('x5sec: в anti-bot ответе не найден punish URL — сразу паркуем');
        }
        logWarn(`Qwen вернул anti-bot челлендж (${tokenObj?.id}) — паркуем аккаунт на ${QWEN_OPS_BAN_HOURS}ч и пробуем другой`);
        markRateLimitedByToken(tokenObj?.token, QWEN_OPS_BAN_HOURS);
        if (isBrowserAccountId(tokenObj?.id) || browserAuthToken === tokenObj?.token) {
            markBrowserTokenRateLimited(tokenObj?.token, QWEN_OPS_BAN_HOURS);
        }
        chatAccountAffinity.forget(chatId);
        if (retryCount < MAX_RETRY_COUNT && await canRetryWithAnotherAccount(tokenObj, requestContext.browserContext)) {
            logInfo('Пересоздаем чат под другим аккаунтом после anti-bot челленджа');
            return retryAfterAccountSwitch(requestContext, sendMessage);
        }
        return { error: 'Qwen вернул anti-bot челлендж; все аккаунты припаркованы', status: 403, chatId };
    }

    // Ретрай после солва может снова зависнуть: WAF пере-челленджит сессию,
    // браузерный fetch виснет и падает с сетевой ошибкой без тела. Это не
    // «мёртвый» аккаунт — пробируем челлендж и решаем его повторно, вместо
    // парковки. Ограничено MAX_RETRY_COUNT, как и остальные ретраи.
    if (isWafRetryHang(response, requestContext)) {
        logWarn(`x5sec: ретрай после солва завис/упал (${tokenObj?.id}): ${response.error?.slice(0, 80)} — пробуем восстановиться`);
        const recovery = await tryRecoverFromWafHang(tokenObj, requestContext);
        if (recovery.kind === 'solved' || recovery.kind === 'ok') {
            logInfo('x5sec: восстановление успешно — повторяем запрос на том же аккаунте');
            return retryAfterChallengeSolve(requestContext, sendMessage);
        }
        logWarn(`x5sec: восстановление не удалось (${recovery.kind}) — отдаём ошибку`);
        return { error: response.error || 'Сетевая ошибка после решения челленджа', chatId };
    }

    return { error: response.error || response.statusText, details: response.errorBody || 'Нет дополнительных деталей', chatId };
}

// ─── Main public API ─────────────────────────────────────────────────────────

export async function sendMessage(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0, onChunk = null, resetMessage = null, clientScope = null, signal = null, forceBrowserFetch = false) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    const validated = validateAndPrepareMessage(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, status: 400, invalidRequest: true, chatId };
    }
    let messageContent = validated.content;

    const filePreflight = preflightFileRequest(messageContent, files, clientScope);
    if (filePreflight.error) return { ...filePreflight, chatId };

    if (!model || model.trim() === '') {
        model = DEFAULT_MODEL;
    } else if (!isValidModel(model)) {
        logWarn(`Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`);
        model = DEFAULT_MODEL;
    }
    logInfo(`Используемая модель: "${model}"`);
    if (chatType !== 't2t') {
        const typeLabels = { t2i: 'изображение', t2v: 'видео' };
        logInfo(`Тип генерации: ${chatType} (${typeLabels[chatType] || chatType})${size ? `, размер: ${size}` : ''}`);
    }

    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', chatId };

    const { fileAffinity } = filePreflight;

    let fileTokenObj = null;
    if (fileAffinity.accountId) {
        const chatAccountId = getResourceAccountId('chat', chatId);
        if (chatAccountId && chatAccountId !== fileAffinity.accountId) {
            return {
                error: 'Чат и прикреплённые файлы принадлежат разным Qwen-аккаунтам. Создайте новый чат или загрузите файлы заново.',
                status: 409,
                chatId,
                reuploadRequired: true
            };
        }
        fileTokenObj = await resolveAccountToken(fileAffinity.accountId, browserContext);
        if (!fileTokenObj) {
            return {
                error: 'Аккаунт прикреплённых файлов недоступен. Загрузите файлы заново перед отправкой.',
                status: 409,
                chatId,
                reuploadRequired: true
            };
        }
    }

    const accountContext = await resolveChatRequestContext({
        chatId,
        parentId,
        affinityRegistry: chatAccountAffinity,
        getAccountToken: accountId => resolveAccountToken(accountId, browserContext),
        selectToken: () => fileTokenObj || resolveAuthToken(browserContext)
    });
    if (!accountContext) return { error: 'Ошибка авторизации: не удалось получить токен', chatId };

    if (accountContext.resetReason) {
        logWarn(`Чат ${chatId} не будет переиспользован (${accountContext.resetReason}); создаём новый чат под выбранным аккаунтом`);
    }

    if ((accountContext.resetReason || retryCount > 0) && resetMessage !== null) {
        const resetValidated = validateAndPrepareMessage(resetMessage);
        if (resetValidated.error) {
            return {
                error: `Некорректный резервный контекст: ${resetValidated.error}`,
                status: 400,
                invalidRequest: true,
                chatId
            };
        }
        messageContent = resetValidated.content;
        logInfo('Контекст клиента свёрнут в один запрос после создания нового Qwen-чата');
    }

    chatId = accountContext.chatId;
    parentId = accountContext.parentId;
    const tokenObj = Object.freeze({ id: accountContext.accountId, token: accountContext.token });
    const retryContext = {
        message,
        model,
        chatId,
        parentId,
        files,
        tools,
        toolChoice,
        systemMessage,
        retryCount,
        chatType,
        size,
        waitForCompletion,
        onChunk,
        resetMessage,
        fileAccountId: fileAffinity.accountId,
        browserContext,
        clientScope,
        signal,
        forceBrowserFetch
    };
    // Запросы и солв челленджа идут в контексте выбранного аккаунта: у каждого
    // свои cookies, и WAF видит консистентную сессию вместо перемешанной.
    retryContext.browserContext = (await resolveRequestBrowserContext(accountContext.accountId)) || browserContext;

    // Проактивная защита от бан-висения для переиспользуемых чатов
    // (для новых чатов проверка уже есть внутри createChatV2).
    if (isOpsOverLimit(tokenObj.token, QWEN_OPS_PER_HOUR, QWEN_OPS_WINDOW_MS)) {
        logWarn(`Аккаунт ${tokenObj.id}: превышен лимит операций Qwen (${QWEN_OPS_PER_HOUR}/час) — паркуем и пробуем другой`);
        markRateLimitedByToken(tokenObj.token, QWEN_OPS_BAN_HOURS);
        return handleApiError(
            { status: 429, errorBody: JSON.stringify({ code: 'RateLimited', message: 'Лимит операций аккаунта' }) },
            tokenObj,
            retryContext
        );
    }

    if (!chatId) {
        const newChatResult = await createChatV2(model, 'Новый чат', 0, chatType, tokenObj);
        if (newChatResult.error) {
            if (newChatResult.status === 401 || newChatResult.status === 429) {
                return handleApiError(newChatResult, tokenObj, retryContext);
            }
            return { error: 'Не удалось создать чат: ' + newChatResult.error };
        }
        chatId = newChatResult.chatId;
        retryContext.chatId = chatId;
        logInfo(`Создан новый чат v2 с ID: ${chatId}`);
    }

    let page = null;
    let completionBanTimer = null;
    try {
        page = await pagePool.getPage(retryContext.browserContext);

        const verificationNeeded = await checkVerification(page);
        if (verificationNeeded) {
            await withOperationGuard(
                page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }),
                {
                    timeoutMs: PAGE_TIMEOUT,
                    signal,
                    label: 'Перезагрузка страницы верификации',
                    onAbort: () => pagePool.disposePage(page)
                }
            );
        }

        logInfo('Отправка запроса к API v2...');

        const payload = buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType, size);
        logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        logDebug(`Отправка сообщения в чат ${chatId} с parent_id: ${parentId || 'null'}`);

        const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;

        // Реактивная страховка от бан-висения: WAF-челлендж x5sec может
        // «зависнуть» в браузере, не отдав тело ответа. Если Qwen не ответил
        // за QWEN_BAN_DETECT_MS — паркуем аккаунт. Запрос НЕ прерываем:
        // длинная генерация может идти дольше; парковка лишь убирает аккаунт
        // из ротации для последующих запросов.
        // Ретрай после солва висит почти наверняка из-за ре-челленджа WAF:
        // вместо парковки на час в фоне пробируем и решаем слайдер — сессия
        // разблокируется, и висящий fetch может завершиться сам. Для обычного
        // запроса (не ретрая) висящий completion — это бан-висение, паркуем.
        if (QWEN_BAN_DETECT_MS > 0) {
            // Для ретрая после солва recovery запускаем раньше (12с по умолчанию),
            // чем бан-парковку обычного запроса (20с): запрос не прерывается,
            // а фоновая разблокировка ускоряет висящий ретрай.
            const hangDetectMs = forceBrowserFetch
                ? Math.min(QWEN_BAN_DETECT_MS, QWEN_WAF_RECOVERY_MS)
                : QWEN_BAN_DETECT_MS;
            completionBanTimer = setTimeout(() => {
                if (forceBrowserFetch) {
                    logWarn(`Ретрай после солва не отвечает ${hangDetectMs}мс (${tokenObj.id}) — в фоне решаем WAF-челлендж`);
                    tryRecoverFromWafHang(tokenObj, retryContext)
                        .then((r) => logInfo(`x5sec: фоновая разблокировка: ${r.kind}`))
                        .catch(() => {});
                } else {
                    logWarn(`Completion не отвечает ${QWEN_BAN_DETECT_MS}мс (${tokenObj.id}) — похоже на WAF-челлендж/бан-висение, паркуем аккаунт на ${QWEN_OPS_BAN_HOURS}ч`);
                    markRateLimitedByToken(tokenObj.token, QWEN_OPS_BAN_HOURS);
                    if (isBrowserAccountId(tokenObj.id) || browserAuthToken === tokenObj.token) {
                        markBrowserTokenRateLimited(tokenObj.token, QWEN_OPS_BAN_HOURS);
                    }
                }
            }, hangDetectMs);
        }

        const response = await executeApiRequest(
            page,
            apiUrl,
            payload,
            tokenObj.token,
            onChunk,
            getBrowserFetchCredentials(tokenObj.id),
            signal,
            { forceBrowserFetch: retryContext.forceBrowserFetch }
        );
        if (completionBanTimer) clearTimeout(completionBanTimer);

        if (response.success && response.isTask) {
            recordOp(tokenObj.token); // сообщение — операция в квоте Qwen
            logInfo('Обнаружен ответ с задачей (видеогенерация)');
            logRaw(JSON.stringify(response.data));

            const taskId = extractTaskId(response.data);
            if (!taskId) {
                logError('Task ID не найден в ответе');
                pagePool.releasePage(page);
                page = null;
                return { error: 'Task ID не найден в ответе', chatId, rawResponse: response.data };
            }

            logInfo(`Task ID: ${taskId}`);
            bindResourceToAccount('task', taskId, tokenObj.id, clientScope);

            if (!waitForCompletion) {
                logInfo('Возвращаем task_id для клиентского polling');
                pagePool.releasePage(page);
                page = null;
                return {
                    id: taskId,
                    object: 'chat.completion.task',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    task_id: taskId,
                    chatId,
                    parentId: response.data.data?.parent_id || taskId,
                    status: 'processing',
                    message: 'Задача генерации видео создана. Для прогресса используйте GET /api/tasks/status/:taskId.'
                };
            }

            logInfo('Начинаем polling для получения видео...');
            const taskResult = await pollTaskStatus(
                taskId,
                page,
                tokenObj.token,
                TASK_POLL_MAX_ATTEMPTS,
                TASK_POLL_INTERVAL,
                getBrowserFetchCredentials(tokenObj.id),
                signal
            );

            pagePool.releasePage(page);
            page = null;

            if (taskResult.success && taskResult.status === 'completed') {
                logInfo('Видео успешно сгенерировано');
                const videoUrl = extractVideoUrl(taskResult.data);
                return {
                    id: taskId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: videoUrl || JSON.stringify(taskResult.data) },
                        finish_reason: 'stop'
                    }],
                    usage: taskResult.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    response_id: taskId,
                    chatId,
                    parentId: taskId,
                    task_id: taskId,
                    video_url: videoUrl
                };
            }

            logError(`Не удалось получить видео: ${taskResult.error}`);
            return { error: taskResult.error || 'Video generation failed', status: taskResult.status, chatId, task_id: taskId };
        }

        pagePool.releasePage(page);
        page = null;

        if (response.success) {
            recordOp(tokenObj.token); // сообщение — операция в квоте Qwen
            logRaw(JSON.stringify(response.data));
            logInfo('Ответ получен успешно');
            bindResourceToAccount('chat', chatId, tokenObj.id);
            response.data.chatId = chatId;
            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();
            
            // Fallback: если поток чанков не был отдан, отправляем контент единым куском.
            if (typeof onChunk === 'function' && response.data.choices?.[0]?.message?.content && !response.hasStreamedChunks) {
                onChunk(response.data.choices[0].message.content);
            }
            
            return response.data;
        }

        return handleApiError(response, tokenObj, retryContext);
    } catch (error) {
        logError('Ошибка при отправке сообщения', error);
        // Реактивная страховка: если completion не ответил до конца гарда
        // (ETIMEDOUT) — Qwen держит запрос (бан-висение). Паркуем аккаунт,
        // чтобы следующие запросы шли на другие аккаунты. Для ретрая после
        // солва таймаут почти наверняка ре-челлендж — сначала восстанавливаемся.
        if (error?.code === 'ETIMEDOUT' && tokenObj?.token) {
            if (forceBrowserFetch && retryCount < MAX_RETRY_COUNT) {
                const recovery = await tryRecoverFromWafHang(tokenObj, retryContext);
                if (recovery.kind === 'solved' || recovery.kind === 'ok') {
                    logInfo('x5sec: восстановление после таймаута ретрая — повторяем запрос');
                    return retryAfterChallengeSolve(retryContext, sendMessage);
                }
                if (recovery.kind === 'busy') {
                    // другое восстановление уже идёт — не паркуем, отдаём временную ошибку
                    return { error: 'Запрос завис; WAF-разблокировка в процессе, повторите', chatId };
                }
                logWarn(`x5sec: восстановление не удалось (${recovery.kind}) — паркуем`);
            }
            logWarn(`Запрос к Qwen не ответил за таймаут (${tokenObj.id}) — похоже на бан-висение, паркуем аккаунт на ${QWEN_OPS_BAN_HOURS}ч`);
            markRateLimitedByToken(tokenObj.token, QWEN_OPS_BAN_HOURS);
            if (isBrowserAccountId(tokenObj.id) || browserAuthToken === tokenObj.token) {
                markBrowserTokenRateLimited(tokenObj.token, QWEN_OPS_BAN_HOURS);
            }
        }
        return { error: error.toString(), chatId };
    } finally {
        if (completionBanTimer) clearTimeout(completionBanTimer);
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// ─── Task response helpers ───────────────────────────────────────────────────

function extractTaskId(data) {
    const firstMsg = data.data?.messages?.[0];
    if (firstMsg?.extra?.wanx?.task_id) return firstMsg.extra.wanx.task_id;
    return data.id || data.task_id || data.response_id || data.data?.message_id || null;
}

function findMediaUrl(value, extensions = ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp']) {
    if (!value) return null;
    if (typeof value === 'string') {
        const direct = value.match(/https?:\/\/[^\s"'<>]+/g)?.find(url => extensions.some(ext => url.toLowerCase().includes(ext)));
        return direct || null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
        return null;
    }
    if (typeof value === 'object') {
        const preferredKeys = ['video_url', 'image_url', 'url', 'content', 'result', 'output', 'data', 'message'];
        for (const key of preferredKeys) {
            if (key in value) {
                const found = findMediaUrl(value[key], extensions);
                if (found) return found;
            }
        }
        for (const item of Object.values(value)) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
    }
    return null;
}

export function extractMediaUrl(value, type = 'any') {
    const extensions = type === 'video'
        ? ['.mp4', '.mov', '.webm']
        : type === 'image'
            ? ['.png', '.jpg', '.jpeg', '.webp']
            : ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp'];
    return findMediaUrl(value, extensions);
}

function extractVideoUrl(taskData) {
    return extractMediaUrl(taskData, 'video');
}

export async function pollQwenTaskStatus(taskId, waitForCompletion = false, clientScope = null, signal = null) {
    const boundAccountId = getResourceAccountId('task', taskId, clientScope);
    if (!boundAccountId) {
        return {
            error: 'Неизвестен аккаунт Qwen-задачи. После перезапуска запустите генерацию заново.',
            status: 404,
            task_id: taskId
        };
    }
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', task_id: taskId };
    const tokenObj = await resolveAccountToken(boundAccountId, browserContext);
    if (!tokenObj?.token) {
        return { error: 'Аккаунт Qwen-задачи недоступен', status: 409, task_id: taskId };
    }
    const requestBrowserContext = (await resolveRequestBrowserContext(tokenObj.id)) || browserContext;

    let page = null;
    try {
        page = await pagePool.getPage(requestBrowserContext);
        const result = waitForCompletion
            ? await pollTaskStatus(
                taskId,
                page,
                tokenObj.token,
                TASK_POLL_MAX_ATTEMPTS,
                TASK_POLL_INTERVAL,
                getBrowserFetchCredentials(tokenObj.id),
                signal
            )
            : await pollTaskStatus(taskId, page, tokenObj.token, 1, 0, getBrowserFetchCredentials(tokenObj.id), signal);

        const mediaUrl = extractMediaUrl(result.data || result, 'video') || extractMediaUrl(result.data || result, 'image');
        return {
            task_id: taskId,
            success: result.success,
            status: result.status,
            error: result.error,
            video_url: extractMediaUrl(result.data || result, 'video'),
            image_url: extractMediaUrl(result.data || result, 'image'),
            media_url: mediaUrl,
            data: result.data
        };
    } finally {
        if (page) pagePool.releasePage(page);
    }
}

export async function clearPagePool() {
    await pagePool.clear();
}

export function getAuthToken() {
    return browserAuthToken;
}

// ─── createChatV2 ────────────────────────────────────────────────────────────

export async function createChatV2(model = DEFAULT_MODEL, title = 'Новый чат', retryCount = 0, chatType = 't2t', preferredTokenObj = null) {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован' };

    const preferredToken = snapshotAccountToken(preferredTokenObj);
    const tokenObj = preferredToken || await resolveAuthToken(browserContext);
    if (!tokenObj) return { error: 'Не удалось получить токен авторизации' };
    logInfo(`Используется аккаунт для создания чата: ${tokenObj.id}`);
    const requestBrowserContext = (await resolveRequestBrowserContext(tokenObj.id)) || browserContext;

    // Проактивная защита от бан-висения: не даём аккаунту превысить лимит
    // операций Qwen в скользящем окне (замерено: ~25-35/час, бан без 429).
    if (isOpsOverLimit(tokenObj.token, QWEN_OPS_PER_HOUR, QWEN_OPS_WINDOW_MS)) {
        logWarn(`Аккаунт ${tokenObj.id}: превышен лимит операций Qwen (${QWEN_OPS_PER_HOUR}/час) — паркуем и пробуем другой`);
        markRateLimitedByToken(tokenObj.token, QWEN_OPS_BAN_HOURS);
        return { error: 'Аккаунт исчерпал лимит операций Qwen', status: 429, accountId: tokenObj.id };
    }

    let page = null;
    try {
        page = await pagePool.getPage(requestBrowserContext);

        const payload = { title, models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now() };
        const requestBody = {
            apiUrl: CREATE_CHAT_URL,
            payload,
            headers: buildQwenRequestHeaders(tokenObj.token),
            credentials: getBrowserFetchCredentials(tokenObj.id)
        };

        const result = await withOperationGuard(
            page.evaluate(async (data) => {
                try {
                    const response = await fetch(data.apiUrl, {
                        method: 'POST',
                        credentials: data.credentials,
                        headers: data.headers,
                        body: JSON.stringify(data.payload)
                    });
                    if (response.ok) return { success: true, data: await response.json() };
                    return { success: false, status: response.status, errorBody: await response.text() };
                } catch (error) {
                    return { success: false, error: error.toString() };
                }
            }, requestBody),
            {
                // create-chat в норме отвечает <1с; если он не ответил за
                // QWEN_BAN_DETECT_MS — это почти наверняка бан-висение Qwen.
                // Короткий гард + парковка по ETIMEDOUT в catch ниже.
                timeoutMs: Math.min(PAGE_EVALUATE_TIMEOUT, QWEN_BAN_DETECT_MS),
                label: 'Создание чата',
                onAbort: () => pagePool.disposePage(page)
            }
        );

        pagePool.releasePage(page);
        page = null;

        if (result.success && result.data?.success && result.data?.data?.id) {
            const createdChatId = result.data.data.id;
            bindResourceToAccount('chat', createdChatId, tokenObj.id);
            recordOp(tokenObj.token); // создание чата — операция в квоте Qwen
            logInfo(`Чат создан: ${createdChatId}`);
            return {
                success: true,
                chatId: createdChatId,
                requestId: result.data.request_id,
                accountId: tokenObj.id
            };
        }

        const structuredErrorBody = result.errorBody || (result.data ? JSON.stringify(result.data) : null);
        const resultCode = result.data?.code || result.data?.data?.code;
        const { kind, effectiveStatus } = classifyQwenError({ status: result.status, errorBody: structuredErrorBody, code: resultCode });
        const isUnauthorized = kind === 'unauthorized';
        const isRateLimited = kind === 'ratelimit';
        if (isUnauthorized) markInvalidByToken(tokenObj.token);
        if (isUnauthorized && (isBrowserAccountId(tokenObj.id) || browserAuthToken === tokenObj.token)) {
            browserAuthToken = null;
            setAuthenticationStatus(false);
        }
        if (isRateLimited) {
            let hours = RATE_LIMIT_DEFAULT_HOURS;
            try {
                const parsedHours = Number(JSON.parse(structuredErrorBody).num);
                hours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : RATE_LIMIT_DEFAULT_HOURS;
            } catch { /* non-JSON body */ }
            markRateLimitedByToken(tokenObj.token, hours);
            if (isBrowserAccountId(tokenObj.id) || browserAuthToken === tokenObj.token) {
                markBrowserTokenRateLimited(tokenObj.token, hours);
            }
        }

        if (!preferredToken && (isUnauthorized || isRateLimited) && retryCount < MAX_RETRY_COUNT && await canRetryWithAnotherAccount(tokenObj, browserContext)) {
            logWarn('Создание чата не удалось из-за аккаунта; повторяем с другим доступным аккаунтом');
            return createChatV2(model, title, retryCount + 1, chatType, null);
        }

        const isTransient = result.status >= 500 && result.status < 600;
        if (isTransient && retryCount < MAX_RETRY_COUNT) {
            logWarn(`Создание чата: ${result.status}, ретрай ${retryCount + 1}/${MAX_RETRY_COUNT} через ${RETRY_DELAY}мс...`);
            await delay(RETRY_DELAY);
            return createChatV2(model, title, retryCount + 1, chatType, preferredTokenObj);
        }

        const cleanError = isTransient
            ? `Qwen API недоступен (${result.status}). Повторите позже.`
            : (structuredErrorBody || result.error || 'Неизвестная ошибка');
        logError(`Ошибка при создании чата: ${result.status || 'unknown'} (попытка ${retryCount + 1})`);
        return {
            error: cleanError,
            status: effectiveStatus,
            statusText: result.statusText,
            errorBody: structuredErrorBody,
            accountId: tokenObj.id
        };
    } catch (error) {
        logError('Ошибка при создании чата', error);
        // Qwen при бане просто держит запрос без ответа — гард истёк по
        // таймауту (ETIMEDOUT). Паркуем аккаунт, чтобы ротация не упиралась
        // в зависший аккаунт, а следующий запрос пошёл на другой.
        if (error?.code === 'ETIMEDOUT' && tokenObj?.token) {
            logWarn(`Создание чата не ответило за ${QWEN_BAN_DETECT_MS}мс (${tokenObj.id}) — похоже на бан-висение Qwen, паркуем аккаунт на ${QWEN_OPS_BAN_HOURS}ч`);
            markRateLimitedByToken(tokenObj.token, QWEN_OPS_BAN_HOURS);
            if (isBrowserAccountId(tokenObj.id) || browserAuthToken === tokenObj.token) {
                markBrowserTokenRateLimited(tokenObj.token, QWEN_OPS_BAN_HOURS);
            }
        }
        return { error: error.toString(), accountId: tokenObj?.id };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

