// tokenImport.js — чистые функции массового импорта токенов Qwen.
//
// Отделены от I/O (чтение файла, запись tokens.json, ping) ради тестируемости:
// scripts/importTokens.js делает только CLI-обвязку поверх этих функций.

export const DEFAULT_ACCOUNT_PREFIX = 'acc_';

// Похоже ли значение на JWT-токен Qwen (eyJ... — три base64url-сегмента).
const JWT_LIKE_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function isJwtLikeToken(value) {
    return typeof value === 'string' && JWT_LIKE_RE.test(value.trim());
}

/**
 * Парсинг произвольного текста (содержимое файла или stdin) в список токенов.
 * Поддерживаются:
 *   - по одному токену на строку (пустые строки и строки с # игнорируются);
 *   - JSON-массив строк: ["eyJ...", ...];
 *   - JSON-массив объектов: [{"token": "eyJ...", "id": "alice"}].
 * @param {string} text
 * @returns {{ token: string, id?: string }[]}
 */
export function parseTokenInput(text) {
    const raw = typeof text === 'string' ? text : '';
    const trimmed = raw.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            const result = [];
            for (const item of items) {
                if (typeof item === 'string') {
                    if (item.trim()) result.push({ token: item.trim() });
                } else if (item && typeof item === 'object') {
                    if (typeof item.token === 'string' && item.token.trim()) {
                        const entry = { token: item.token.trim() };
                        if (typeof item.id === 'string' && item.id.trim()) entry.id = item.id.trim();
                        result.push(entry);
                    }
                }
            }
            return result;
        } catch {
            // Не JSON — продолжаем построчный разбор ниже.
        }
    }

    return raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
            // Поддержка «id=токен» или «id: токен» для именованных аккаунтов.
            const named = line.match(/^([A-Za-z0-9_-]+)\s*[=:]\s*(\S+)$/);
            if (named) return { token: named[2], id: named[1] };
            return { token: line };
        })
        .filter(item => item && item.token);
}

/**
 * Нормализация id аккаунта: только безопасные символы.
 */
export function sanitizeAccountId(value, fallback = null) {
    if (typeof value !== 'string') return fallback;
    const cleaned = value.trim().replace(/[^A-Za-z0-9_:-]/g, '_');
    return cleaned || fallback;
}

/**
 * План импорта: какие токены добавить, какие уже есть.
 *
 * @param {Array<{id?: string, token?: string}>} existing — текущие записи tokens.json
 * @param {Array<{token: string, id?: string}>} incoming — из parseTokenInput
 * @param {{ prefix?: string, now?: number }} [options]
 * @returns {{ toAdd: Array<{id: string, token: string}>, duplicates: number, skippedEmpty: number }}
 */
export function buildImportPlan(existing = [], incoming = [], { prefix = DEFAULT_ACCOUNT_PREFIX, now = Date.now() } = {}) {
    const existingTokens = new Set();
    for (const entry of existing) {
        if (typeof entry?.token === 'string' && entry.token) existingTokens.add(entry.token);
    }

    const toAdd = [];
    const seenInBatch = new Set();
    let duplicates = 0;
    let skippedEmpty = 0;

    let seq = 0;
    const base = now.toString(36);
    for (const item of incoming) {
        const token = typeof item?.token === 'string' ? item.token.trim() : '';
        if (!token) {
            skippedEmpty++;
            continue;
        }
        if (existingTokens.has(token) || seenInBatch.has(token)) {
            duplicates++;
            continue;
        }
        seenInBatch.add(token);

        seq++;
        const id = sanitizeAccountId(item.id, null) || `${prefix}${base}_${seq}`;
        toAdd.push({ id, token });
    }

    return { toAdd, duplicates, skippedEmpty };
}
