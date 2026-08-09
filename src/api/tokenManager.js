import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from '../logger/index.js';
import { SESSION_DIR, ACCOUNTS_DIR, ACCOUNT_SUBSET, RATE_LIMIT_DEFAULT_HOURS } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_PATH = path.resolve(__dirname, '..', '..', SESSION_DIR);
const ACCOUNTS_PATH = path.join(SESSION_PATH, ACCOUNTS_DIR);
const TOKENS_FILE = path.join(SESSION_PATH, 'tokens.json');

let pointer = 0;

function isAvailableToken(token, now = Date.now()) {
    return Boolean(token?.token)
        && token.invalid !== true
        && (!token.resetAt || new Date(token.resetAt).getTime() <= now);
}

// FNV-1a (32 бита): стабильный, детерминированный хэш id аккаунта.
// Используется для авто-распределения аккаунтов между воркерами: один и тот же
// аккаунт всегда попадает в одну и ту же долю, добавление/удаление аккаунтов
// не «перетасовывает» остальные.
export function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * Чистая функция: назначен ли аккаунт этому инстансу?
 *
 * @param {string} accountId — id аккаунта (например 'acc_...')
 * @param {string} [subset]  — формат подмножества:
 *   ''      — все аккаунты;
 *   'k/n'   — k-я доля из n воркеров (fnv1a(id) % n === k);
 *   'a,b,c' — явный список id.
 */
export function accountBelongsToSubset(accountId, subset = ACCOUNT_SUBSET) {
    if (!subset) return true;
    const shard = subset.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (shard) {
        const k = Number(shard[1]);
        const n = Number(shard[2]);
        if (n > 1 && k >= 0 && k < n) {
            return fnv1a(String(accountId)) % n === k;
        }
        return true; // некорректный формат — не фильтруем
    }
    const ids = subset.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return true;
    return ids.includes(accountId);
}

// Фильтр только для чтения аккаунтов: запись (markInvalid/markRateLimited/...)
// работает по полному реестру — файл общий, и воркер может пометить любой аккаунт.
function filterForInstance(tokens) {
    return tokens.filter(t => t && t.id && accountBelongsToSubset(t.id));
}

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_PATH)) fs.mkdirSync(ACCOUNTS_PATH, { recursive: true });
}

export function loadTokens() {
    ensureSessionDir();
    if (!fs.existsSync(TOKENS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    } catch (e) {
        logError('TokenManager: ошибка чтения tokens.json', e);
        return [];
    }
}

export function saveTokens(tokens) {
    ensureSessionDir();
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    } catch (e) {
        logError('TokenManager: ошибка сохранения tokens.json', e);
    }
}

export async function getAvailableToken() {
    const tokens = filterForInstance(loadTokens());
    const now = Date.now();
    const valid = tokens.filter(token => isAvailableToken(token, now));
    if (!valid.length) return null;
    const token = valid[pointer % valid.length];
    pointer = (pointer + 1) % valid.length;
    return token;
}

export function getAvailableTokenById(id) {
    if (!id) return null;
    const token = filterForInstance(loadTokens()).find(candidate => candidate.id === id);
    return isAvailableToken(token) ? token : null;
}

export function hasValidTokens() {
    const tokens = filterForInstance(loadTokens());
    const now = Date.now();
    return tokens.some(token => isAvailableToken(token, now));
}

export function markRateLimited(id, hours = RATE_LIMIT_DEFAULT_HOURS) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        tokens[idx].resetAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        saveTokens(tokens);
    }
}

export function markRateLimitedByToken(tokenValue, hours = RATE_LIMIT_DEFAULT_HOURS) {
    if (typeof tokenValue !== 'string' || !tokenValue) return 0;
    const tokens = loadTokens();
    const resetAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    let updated = 0;
    for (const token of tokens) {
        if (token.token === tokenValue) {
            token.resetAt = resetAt;
            updated++;
        }
    }
    if (updated > 0) saveTokens(tokens);
    return updated;
}

export function removeToken(id) {
    saveTokens(loadTokens().filter(t => t.id !== id));
}

export { removeToken as removeInvalidToken };

export function markInvalid(id) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) { tokens[idx].invalid = true; saveTokens(tokens); }
}

export function markInvalidByToken(tokenValue) {
    if (typeof tokenValue !== 'string' || !tokenValue) return 0;
    const tokens = loadTokens();
    let updated = 0;
    for (const token of tokens) {
        if (token.token === tokenValue) {
            token.invalid = true;
            updated++;
        }
    }
    if (updated > 0) saveTokens(tokens);
    return updated;
}

export function markValid(id, newToken) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        tokens[idx].invalid = false;
        tokens[idx].resetAt = null;
        if (newToken) tokens[idx].token = newToken;
        saveTokens(tokens);
    }
}

export function listTokens() {
    return filterForInstance(loadTokens());
}
