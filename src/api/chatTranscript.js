// src/api/chatTranscript.js
// Транскрипты бесед для history-derived chatId (unscoped restore, ALLOW_UNSCOPED_SESSION_CHAT_RESTORE).
//
// Зачем:
//  1. Различать сессии с одинаковым первым сообщением. Старый подход хешировал только
//     первое сообщение пользователя — две сессии OpenCode с одним и тем же открывающим
//     промптом («Привет», «Напиши план»…) получали один chatId и один Qwen-чат: контекст
//     второй сессии «заражался» первой. Теперь беседа переиспользуется только если
//     входящая последовательность сообщений — прямое продолжение сохранённой
//     (проверка непрерывности); иначе создаётся отдельная fork-беседа.
//  2. Строить оконный fold из собственного транскрипта при пересоздании Qwen-чата
//     (свап аккаунта, рестарт) — контекст не зависит от того, что прислал клиент,
//     и размер свёртки ограничен (не раздувается на длинных сессиях).

import crypto from 'crypto';

const MAX_FORKS_PER_BASE = 64;   // максимум параллельных бесед с одним первым сообщением
const MAX_TURNS_STORED = 240;    // хвост беседы, который храним для фолда
const MAX_FOLD_CHARS = 60_000;   // потолок свёрнутого контекста (символы)

function hashContent(content) {
    return crypto.createHash('sha1').update(String(content ?? '')).digest('hex').slice(0, 16);
}

function looksLikeToolEnvelope(content) {
    if (typeof content !== 'string') return false;
    const t = content.trim();
    if (!t) return false;
    if (t === '{}') return true;
    if (t[0] !== '{') return false;
    try {
        const parsed = JSON.parse(t);
        return !!parsed && typeof parsed === 'object' && Array.isArray(parsed.tool_calls);
    } catch {
        return false;
    }
}

export function messageKey(message) {
    const role = message && typeof message.role === 'string' ? message.role : 'unknown';
    const raw = message && message.content !== undefined ? message.content : '';
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
    // Tool-call ходы клиент (OpenCode) сериализует иначе, чем мы получаем от Qwen,
    // поэтому нормализуем их в фиксированный маркер: важно, чтобы оба варианта
    // (пустой content + tool_calls и JSON-обёртка от Qwen) давали один ключ.
    if (role === 'assistant' && (content === '' || looksLikeToolEnvelope(content))) {
        return 'assistant:[tool]';
    }
    return `${role}:${hashContent(content)}`;
}

export function sequenceKeys(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.filter(m => m && m.role).map(messageKey);
}

function makeTurns(messages) {
    const turns = [];
    for (const m of messages || []) {
        if (!m) continue;
        const role = typeof m.role === 'string' ? m.role : '';
        if (role !== 'user' && role !== 'assistant') continue;
        const raw = m.content !== undefined ? m.content : '';
        const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (role === 'assistant' && (content === '' || looksLikeToolEnvelope(content))) continue;
        turns.push({ role, content });
    }
    return turns.slice(-MAX_TURNS_STORED);
}

export function createChatTranscriptStore() {
    const byBase = new Map(); // baseId -> [{ internalId, keys, turns }]
    const byId = new Map();   // internalId -> entry

    function listFor(baseId) {
        let list = byBase.get(baseId);
        if (!list) { list = []; byBase.set(baseId, list); }
        return list;
    }

    function capTurns(entry) {
        if (entry.turns.length > MAX_TURNS_STORED) {
            entry.turns = entry.turns.slice(-MAX_TURNS_STORED);
        }
    }

    return Object.freeze({
        /** Самое длинное продолжение беседы под baseId, чьи keys — префикс incomingKeys (или равны). */
        findContinuation(baseId, incomingKeys) {
            if (!baseId || !Array.isArray(incomingKeys) || incomingKeys.length === 0) return null;
            let best = null;
            let bestLen = -1;
            for (const fork of listFor(baseId)) {
                const s = fork.keys;
                if (s.length === 0 || s.length > incomingKeys.length) continue;
                let prefix = true;
                for (let i = 0; i < s.length; i++) {
                    if (s[i] !== incomingKeys[i]) { prefix = false; break; }
                }
                if (prefix && s.length > bestLen) { best = fork.internalId; bestLen = s.length; }
            }
            return best;
        },

        /** Создаёт новую fork-беседу под baseId с полной входящей последовательностью. */
        fork(baseId, incomingKeys, messages) {
            const list = listFor(baseId);
            if (list.length >= MAX_FORKS_PER_BASE) {
                // Патологический случай: 64 беседы с одним первым сообщением от одного клиента.
                // Переиспользуем самую старую (реальный кейс — 2–5 бесед).
                const oldest = list[0];
                oldest.keys = incomingKeys.slice();
                oldest.turns = makeTurns(messages);
                byId.set(oldest.internalId, oldest);
                return oldest.internalId;
            }
            const n = list.length + 1;
            const internalId = `${baseId}::f${n}`;
            const entry = { internalId, baseId, keys: incomingKeys.slice(), turns: makeTurns(messages) };
            list.push(entry);
            byId.set(internalId, entry);
            return internalId;
        },

        /** Дописывает новые сообщения (diff) к существующей беседе. */
        appendDiff(internalId, incomingKeys, messages) {
            const entry = byId.get(internalId);
            if (!entry) return false;
            const start = entry.keys.length;
            if (start > incomingKeys.length) return false; // не продолжение — игнорируем
            for (let i = start; i < incomingKeys.length; i++) {
                entry.keys.push(incomingKeys[i]);
                const m = messages && messages[i];
                if (m) {
                    const role = typeof m.role === 'string' ? m.role : '';
                    if (role === 'user' || role === 'assistant') {
                        const raw = m.content !== undefined ? m.content : '';
                        const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
                        if (!(role === 'assistant' && (content === '' || looksLikeToolEnvelope(content)))) {
                            entry.turns.push({ role, content });
                        }
                    }
                }
            }
            capTurns(entry);
            return true;
        },

        /** Добавляет ответ ассистента — для проверки непрерывности следующего хода. */
        appendAssistant(internalId, content) {
            const entry = byId.get(internalId);
            if (!entry) return false;
            const text = typeof content === 'string' ? content : String(content ?? '');
            entry.keys.push(messageKey({ role: 'assistant', content: text }));
            if (text && !looksLikeToolEnvelope(text)) {
                entry.turns.push({ role: 'assistant', content: text });
                capTurns(entry);
            }
            return true;
        },

        /** Оконный fold транскрипта: хвост беседы, обрезанный по размеру (порядок сохранён). */
        buildWindowedTranscript(internalId, { maxChars = MAX_FOLD_CHARS } = {}) {
            const entry = byId.get(internalId);
            if (!entry || entry.turns.length === 0) return null;
            const parts = [];
            let total = 0;
            for (let i = entry.turns.length - 1; i >= 0; i--) {
                const t = entry.turns[i];
                const line = `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`;
                const capped = line.length > maxChars ? line.slice(0, maxChars) : line;
                if (total + capped.length > maxChars && parts.length > 0) break;
                parts.unshift(capped);
                total += capped.length;
            }
            return parts.join('\n\n');
        },

        _debug() {
            return { byBase: byBase.size, byId: byId.size };
        }
    });
}

// Синглтон, разделяемый всеми хендлерами (как conversationIdentity).
export const chatTranscriptStore = createChatTranscriptStore();
