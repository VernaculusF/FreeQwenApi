import express from 'express';
import { sendMessage, getAllModels, getApiKeys, createChatV2, pollQwenTaskStatus, extractMediaUrl, pagePool, extractAuthToken, getAuthToken, preflightFileRequest } from './chat.js';
import { checkQwenAuthLive } from './authStatusCheck.js';
import { sendApiResultError } from './apiErrors.js';
import { resolveAuthDecision } from './authPolicy.js';
import { getAuthenticationStatus, getBrowserContext } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { logInfo, logWarn, logError, logDebug } from '../logger/index.js';
import { getMappedModel } from './modelMapping.js';
import { getStsToken, uploadFileToQwen } from './fileUpload.js';
import { loadHistory, saveHistory } from './chatHistory.js';
import { generateImage, getAvailableImageModels, checkImageApiAvailability } from './imageGeneration.js';
import { MAX_FILE_SIZE, UPLOADS_DIR, DEFAULT_MODEL, STREAMING_CHUNK_DELAY, ALLOW_UNSCOPED_SESSION_CHAT_RESTORE, HOST, PORT, REQUIRE_API_KEYS } from '../config.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { parseToolCallJson } from './toolParser.js';
import { chatTranscriptStore, sequenceKeys } from './chatTranscript.js';
import { listTokens, markInvalid, markRateLimited, markValid } from './tokenManager.js';
import { buildStatelessTranscript } from '../utils/statelessTranscript.js';
import { FORGETMEAI_WATERMARK } from '../utils/branding.js';
import {
    canonicalizeConversationKey,
    createClientScope,
    createConversationIdentityRegistry,
    createKeyedQueue,
    createScopedConversationAlias,
    scopeClientChatIdentity
} from './keyedQueue.js';

// Функция для генерирования детерминированного chatId на основе истории
function generateChatIdFromHistory(messages, req) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    
    // Фильтруем служебные сообщения Open WebUI
    // Игнорируем сообщения, которые начинаются с "### Task:" или "History:"
    const realMessages = messages.filter(m => {
        if (m.role !== 'user') return true;
        const content = typeof m.content === 'string' ? m.content : '';
        return !content.startsWith('### Task:') && !content.startsWith('History:');
    });
    
    // Если остались только служебные сообщения, используем исходные
    const messagesToUse = realMessages.length > 0 ? realMessages : messages;
    
    // Используем хеш первого реального сообщения пользователя для создания стабильного ID
    const userMessages = messagesToUse
        .filter(m => m.role === 'user')
        .slice(0, 1) // Берём первое сообщение пользователя
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('||');
    
    if (!userMessages) return null;
    
    // Создаём хеш для детерминированного ID
    return createScopedConversationAlias(userMessages, getSessionKey(req), 'legacy-history');
}

function normalizeIdValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower === 'null' || lower === 'undefined') return null;

    return trimmed;
}

function pickFirstId(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeIdValue(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function buildInternalChatIdFromHint(hint, req) {
    const normalizedHint = normalizeIdValue(hint);
    if (!normalizedHint) return null;
    return createScopedConversationAlias(normalizedHint, getSessionKey(req));
}

function scopeClientChatId(chatId, req) {
    const normalizedChatId = normalizeIdValue(chatId);
    if (!normalizedChatId) return null;
    // Every id received from a client crosses the trust boundary and is scoped,
    // including UUID-looking and previously returned upstream ids. A scoped
    // alias for each returned upstream is registered by mapChatId below.
    return scopeClientChatIdentity(normalizedChatId, getSessionKey(req));
}

function extractConversationHint(req) {
    const body = req.body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.conversation_id,
        body.conversationId,
        body.chat_id,
        metadata.conversation_id,
        metadata.conversationId,
        metadata.chat_id,
        metadata.chatId,
        req.get?.('x-conversation-id'),
        req.get?.('x-openwebui-conversation-id'),
        req.get?.('x-chat-id'),
        req.get?.('x-openwebui-chat-id')
    ]);
}

function extractParentHint(req) {
    const body = req.body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.parentId,
        body.parent_id,
        body.x_qwen_parent_id,
        body.response_id,
        metadata.parentId,
        metadata.parent_id,
        metadata.response_id,
        req.get?.('x-parent-id'),
        req.get?.('x-openwebui-parent-id')
    ]);
}

function isTruthyFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function shouldForceNewChat(req) {
    const body = req.body || {};

    return [
        body.newChat,
        body.new_chat,
        body.resetChat,
        body.reset_chat,
        req.get?.('x-new-chat'),
        req.get?.('x-reset-chat')
    ].some(isTruthyFlag);
}

function shouldPersistSessionContext(scope = null) {
    const normalizedScope = normalizeIdValue(scope);
    return Boolean(normalizedScope) || ALLOW_UNSCOPED_SESSION_CHAT_RESTORE;
}

// Глобальное хранилище для маппинга между сгенерированными ID и реальными Qwen chatId
const conversationIdentity = createConversationIdentityRegistry();
const ANY_CURRENT_CHAT = Symbol('any-current-chat');

function mapChatId(generatedId, qwenChatId, expectedCurrentId = ANY_CURRENT_CHAT, clientScope = null) {
    if (!generatedId || !qwenChatId) return false;
    const compareCurrent = expectedCurrentId !== ANY_CURRENT_CHAT;
    const mapped = conversationIdentity.map(generatedId, qwenChatId, {
        compareCurrent,
        expectedCurrent: compareCurrent ? expectedCurrentId : null
    });
    if (!mapped) {
        const currentChatId = conversationIdentity.resolve(generatedId);
        logDebug(`Пропущен устаревший маппинг ${generatedId}: ожидался ${expectedCurrentId || 'null'}, сейчас ${currentChatId || 'null'}`);
        return false;
    }
    const scopedUpstreamAlias = clientScope
        ? scopeClientChatIdentity(qwenChatId, clientScope)
        : null;
    if (scopedUpstreamAlias && scopedUpstreamAlias !== generatedId) {
        conversationIdentity.map(scopedUpstreamAlias, qwenChatId);
    }
    logDebug(`Маппинг чата: ${generatedId} -> ${qwenChatId}`);
    return true;
}

function registerClientUpstreamChatId(qwenChatId, clientScope) {
    if (!qwenChatId || !clientScope) return false;
    const scopedUpstreamAlias = scopeClientChatIdentity(qwenChatId, clientScope);
    return conversationIdentity.map(scopedUpstreamAlias, qwenChatId);
}

function persistChatIdentity(effectiveChatId, resultChatId, resolvedChatId, req) {
    if (!resultChatId) return false;
    const clientScope = getSessionKey(req);
    if (effectiveChatId && resultChatId !== effectiveChatId) {
        return mapChatId(
            effectiveChatId,
            resultChatId,
            expectedMappedChatId(effectiveChatId, resolvedChatId),
            clientScope
        );
    }
    return registerClientUpstreamChatId(resultChatId, clientScope);
}

function persistRequestChatIdentity(effectiveChatId, resultChatId, resolvedChatId, req) {
    const primaryPersisted = persistChatIdentity(effectiveChatId, resultChatId, resolvedChatId, req);
    if (!primaryPersisted && effectiveChatId) return false;

    const conversationHint = extractConversationHint(req);
    const hintAlias = conversationHint ? buildInternalChatIdFromHint(conversationHint, req) : null;
    if (!hintAlias || hintAlias === effectiveChatId) return primaryPersisted;

    const expectedCurrent = conversationIdentity.resolve(hintAlias);
    return mapChatId(
        hintAlias,
        resultChatId,
        expectedCurrent,
        getSessionKey(req)
    );
}

function getChatIdFromMap(generatedId) {
    return conversationIdentity.resolve(generatedId);
}

function getStableChatLockKey(chatId) {
    return conversationIdentity.lockKey(chatId);
}

async function resolveQwenChatId(effectiveChatId) {
    const mapped = getChatIdFromMap(effectiveChatId);

    if (mapped) {
        logInfo(`🔁 Используется сопоставленный Qwen chatId: ${mapped} (from ${effectiveChatId})`);
        return mapped;
    }

    // Leave an unknown alias intact. sendMessage will atomically choose an
    // account, create the chat with that same account, and use reset context.
    return effectiveChatId;
}

function expectedMappedChatId(effectiveChatId, resolvedChatId) {
    if (!effectiveChatId) return null;
    if (conversationIdentity.has(effectiveChatId)) {
        return conversationIdentity.resolve(effectiveChatId);
    }
    return resolvedChatId === effectiveChatId ? null : resolvedChatId;
}

function isOpenWebUiMetaRequest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const lastUserMessage = messages.filter(m => m && m.role === 'user').pop();
    if (!lastUserMessage) return false;

    const content = lastUserMessage.content;
    if (Array.isArray(content)) return false; // multimodal / normal user message
    if (typeof content !== 'string') return false;

    const text = content.trimStart();

    // OpenWebUI background/meta prompts that should not reuse the main chatId/session.
    if (text.startsWith('### Task:')) return true;
    if (text.startsWith('History:')) return true;

    // Some variants embed history blocks and task instructions.
    if (text.includes('<chat_history>') && text.includes('### Task:')) return true;

    return false;
}

// ============================================
// СЕССИОННАЯ СИСТЕМА ДЛЯ ОТСЛЕЖИВАНИЯ ЧАТОВ
// ============================================
// Scoped-сессии (по conversation_id/chat_id) включены всегда.
// Unscoped fallback по IP + User-Agent работает только в legacy-режиме
// через ALLOW_UNSCOPED_SESSION_CHAT_RESTORE=true.
const sessionToChatMap = new Map(); // session-key -> {chatId, parentId, timestamp}

function getSessionKey(req) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    return createClientScope({
        ip,
        userAgent,
        credentialFingerprint: req.proxyClientKeyFingerprint || null
    });
}

function getScopedSessionKey(req, scope = null) {
    const baseKey = getSessionKey(req);
    const normalizedScope = normalizeIdValue(scope);
    return normalizedScope ? `${baseKey}::${normalizedScope}` : baseKey;
}

function getSavedChatId(req, scope = null) {
    const keysToTry = [getScopedSessionKey(req, scope)];

    for (const sessionKey of keysToTry) {
        const sessionData = sessionToChatMap.get(sessionKey);
        if (sessionData && (Date.now() - sessionData.timestamp) < 3600000) { // 1 hour
            return sessionData;
        }
    }

    return null;
}
function saveChatIdForSession(req, chatId, parentId, scope = null) {
    const sessionKey = getScopedSessionKey(req, scope);
    const normalizedScope = normalizeIdValue(scope);

    sessionToChatMap.set(sessionKey, {
        chatId,
        parentId,
        scope: normalizedScope,
        timestamp: Date.now()
    });

    const scopeSuffix = normalizedScope ? ` (scope=${normalizedScope})` : "";
    logDebug(`Saved chatId ${chatId} for session ${sessionKey.substring(0, 8)}${scopeSuffix}`);
}
// Очистка старых сессий каждые 10 минут
setInterval(() => {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    let cleaned = 0;
    for (const [key, value] of sessionToChatMap.entries()) {
        if (value.timestamp < oneHourAgo) {
            sessionToChatMap.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        logDebug(`Очищено ${cleaned} старых сессий`);
    }
}, 600000); // 10 минут

const router = express.Router();
const conversationQueue = createKeyedQueue();

// Отменяет обработку запроса, если клиент оборвал соединение (SSE-disconnect).
// sendMessage/поллинг получают signal и освобождают страницу из пула раньше,
// чем истёк бы таймаут.
function withClientAbortSignal(res) {
    const controller = new AbortController();
    const onClose = () => {
        if (!res.writableEnded) controller.abort();
    };
    res.once('close', onClose);
    return controller.signal;
}

// Безопасное завершение SSE-ответа: после обрыва клиента писать в сокет нельзя,
// иначе — синхронный ERR_STREAM_DESTROYED и шум в логах.
function safeEndSse(res) {
    if (res.destroyed || res.writableEnded) return;
    res.write('data: [DONE]\n\n');
    res.end();
}

router.head('/', (req, res) => res.sendStatus(200));
router.get('/', (req, res) => res.json({ ok: true, service: 'FreeQwenApi', baseUrl: '/api' }));

// ─── Multer для загрузки файлов ──────────────────────────────────────────────

const storage = multer.diskStorage({
    destination(req, file, cb) {
        const uploadDir = path.join(process.cwd(), UPLOADS_DIR);
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename(req, file, cb) {
        cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '-' + file.originalname);
    }
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// ─── Auth middleware ─────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
    // /health — публичный liveness-эндпоинт для healthcheck'ов (Docker/K8s):
    // не содержит секретов и не требует авторизации.
    if (req.path === '/health') return next();

    const decision = resolveAuthDecision({
        apiKeys: getApiKeys(),
        authHeader: req.headers.authorization,
        requireApiKeys: REQUIRE_API_KEYS
    });
    if (!decision.ok) {
        logError(decision.error);
        return res.status(decision.status).json({ error: decision.error });
    }
    req.proxyClientKeyFingerprint = decision.fingerprint;
    next();
}

router.use(authMiddleware);
router.use((req, res, next) => {
    req.url = req.url.replace(/\/v[12](?=\/|$)/g, '').replace(/\/+/g, '/');
    next();
});
router.use(async (req, res, next) => {
    const isChatRequest = req.method === 'POST' && ['/chat', '/chat/completions'].includes(req.path);
    if (!isChatRequest || isOpenWebUiMetaRequest(req.body?.messages)) return next();

    const explicitChatId = normalizeIdValue(req.body?.chatId) || normalizeIdValue(req.body?.chat_id);
    const conversationHint = extractConversationHint(req);
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const queueChatId = explicitChatId
        ? scopeClientChatId(explicitChatId, req)
        : conversationHint
            ? buildInternalChatIdFromHint(conversationHint, req)
            : ALLOW_UNSCOPED_SESSION_CHAT_RESTORE
                ? generateChatIdFromHistory(messages, req)
                : null;

    const canonicalQueueChatId = canonicalizeConversationKey(queueChatId, getStableChatLockKey);
    if (!canonicalQueueChatId) return next();

    let closedWhileWaiting = false;
    const markClosedWhileWaiting = () => { closedWhileWaiting = true; };
    res.once('close', markClosedWhileWaiting);

    let release;
    try {
        release = await conversationQueue.acquire(canonicalQueueChatId);
    } catch (error) {
        res.off('close', markClosedWhileWaiting);
        return next(error);
    }
    res.off('close', markClosedWhileWaiting);
    if (closedWhileWaiting || res.destroyed || res.writableEnded) {
        release();
        return;
    }

    let released = false;
    const releaseOnce = () => {
        if (released) return;
        released = true;
        res.off('finish', releaseOnce);
        res.off('close', releaseOnce);
        release();
    };
    res.once('finish', releaseOnce);
    res.once('close', releaseOnce);
    try {
        next();
    } catch (error) {
        releaseOnce();
        next(error);
    }
});

// ─── Helpers: message parsing ────────────────────────────────────────────────

function parseOpenAIMessages(messages) {
    const systemMsg = messages.find(msg => msg.role === 'system');
    const systemMessage = systemMsg ? systemMsg.content : null;
    const lastUserMessage = messages.filter(msg => msg.role === 'user').pop();
    
    if (!lastUserMessage) {
        return { messageContent: null, systemMessage };
    }
    
    let messageContent = lastUserMessage.content;
    
    // Преобразуем OpenAI format content array во внутренний формат
    if (Array.isArray(messageContent)) {
        messageContent = messageContent.map(item => {
            if (item.type === 'text') {
                return { type: 'text', text: item.text };
            } else if (item.type === 'image_url' && item.image_url) {
                // OpenAI format: image_url: { url: '...' }
                return { type: 'image', image: item.image_url.url };
            } else if (item.type === 'image') {
                // Уже во внутреннем формате
                return { type: 'image', image: item.image };
            }
            return item;
        });
    }
    
    return { messageContent, systemMessage };
}

function buildCombinedTools(tools, functions, toolChoice) {
    const combinedTools = tools || (functions ? functions.map(fn => ({ type: 'function', function: fn })) : null);
    return { combinedTools, toolChoice };
}function hasOpenAIToolState(messages) {
    return (messages || []).some(msg =>
        msg?.role === 'tool' ||
        msg?.role === 'function' ||
        (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
        (msg?.role === 'assistant' && msg.function_call)
    );
}

function shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId) {
    const nonSystemMessages = (messages || []).filter(msg => msg && msg.role !== 'system');
    if (nonSystemMessages.length === 0) return false;

    // Hermes/OpenAI agents send the full state every request. After a tool call the
    // next request often ends with role=tool, not role=user. Qwen Chat has no native
    // OpenAI tool-result role, so preserving context means folding the whole OpenAI
    // transcript into a single user message for that turn.
    if (hasOpenAIToolState(messages)) return true;

    // If FreeQwenApi is used as a stateless OpenAI-compatible endpoint and no
    // conversation id/chat id was provided, keep the complete client-side history.
    if (!effectiveChatId && nonSystemMessages.length > 1) return true;

    // When tools are available, prefer the OpenAI transcript over Qwen's opaque web
    // chat memory on multi-message turns. This keeps Hermes skill/tool discipline in
    // the prompt visible to Qwen instead of depending on previous web-chat state.
    // With a known chatId the Qwen chat already holds the conversation, so folding
    // would duplicate it — only fold when we are starting fresh/stateless.
    if (Array.isArray(combinedTools) && combinedTools.length > 0 && nonSystemMessages.length > 1 && !effectiveChatId) return true;

    return false;
}

function prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId) {
    const lastUserMessage = (messages || []).filter(msg => msg && msg.role === 'user').pop();
    const nonSystemMessages = (messages || []).filter(msg => msg && msg.role !== 'system');
    if (shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId)) {
        const transcript = buildStatelessTranscript(messages);
        return {
            messageContent: transcript,
            resetMessageContent: transcript,
            files: lastUserMessage?.files || [],
            folded: true,
            missingUser: false
        };
    }

    if (!lastUserMessage) {
        return { messageContent: null, resetMessageContent: null, files: [], folded: false, missingUser: true };
    }

    return {
        messageContent: lastUserMessage.content,
        resetMessageContent: nonSystemMessages.length > 1 ? buildStatelessTranscript(messages) : null,
        files: lastUserMessage.files || [],
        folded: false,
        missingUser: false
    };
}

function truncateForPrompt(value, maxLen = 240) {
    const text = String(value || '');
    return text.length > maxLen ? text.slice(0, maxLen).trimEnd() + '…' : text;
}

function compactJsonSchema(schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 2) return schema;
    if (Array.isArray(schema)) return schema.slice(0, 20).map(item => compactJsonSchema(item, depth + 1));

    const out = {};
    for (const key of ['type', 'enum', 'required', 'default']) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (schema.description) out.description = truncateForPrompt(schema.description, depth === 0 ? 180 : 90);
    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = {};
        for (const [name, prop] of Object.entries(schema.properties)) {
            out.properties[name] = compactJsonSchema(prop, depth + 1);
        }
    }
    if (schema.items) out.items = compactJsonSchema(schema.items, depth + 1);
    if (schema.oneOf) out.oneOf = compactJsonSchema(schema.oneOf, depth + 1);
    if (schema.anyOf) out.anyOf = compactJsonSchema(schema.anyOf, depth + 1);
    return out;
}

function minimalJsonSchema(schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 2) return undefined;
    if (Array.isArray(schema)) return schema.slice(0, 8).map(item => minimalJsonSchema(item, depth + 1)).filter(Boolean);

    const out = {};
    for (const key of ['type', 'enum', 'required']) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = {};
        for (const [name, prop] of Object.entries(schema.properties)) {
            out.properties[name] = minimalJsonSchema(prop, depth + 1) || { type: prop?.type || 'string' };
        }
    }
    if (schema.items) out.items = minimalJsonSchema(schema.items, depth + 1) || { type: schema.items?.type || 'string' };
    if (schema.oneOf) out.oneOf = minimalJsonSchema(schema.oneOf, depth + 1);
    if (schema.anyOf) out.anyOf = minimalJsonSchema(schema.anyOf, depth + 1);
    return out;
}

function toolsToPrompt(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';

    const priorityNames = new Set([
        'skill_view', 'skills_list', 'skill_manage',
        'read_file', 'search_files', 'write_file', 'patch', 'terminal', 'process',
        'web_search', 'web_extract', 'session_search', 'todo', 'clarify', 'delegate_task'
    ]);

    const toolPromptMode = (process.env.QWEN_TOOL_PROMPT_MODE || 'compact').toLowerCase();
    const schemas = tools.map(tool => {
        const fn = tool?.function || tool;
        if (!fn?.name) return null;
        const priority = priorityNames.has(fn.name) ? 0 : 1;
        if (toolPromptMode === 'names' && priority > 0) {
            return { name: fn.name, priority };
        }
        if (toolPromptMode === 'minimal') {
            const schema = {
                name: fn.name,
                parameters: minimalJsonSchema(fn.parameters || { type: 'object', properties: {} }) || { type: 'object', properties: {} },
                priority
            };
            if (priority === 0 && fn.description) schema.description = truncateForPrompt(fn.description, 120);
            return schema;
        }
        return {
            name: fn.name,
            description: truncateForPrompt(fn.description || '', priority === 0 ? 420 : 180),
            parameters: compactJsonSchema(fn.parameters || { type: 'object', properties: {} }),
            priority
        };
    }).filter(Boolean).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

    if (schemas.length === 0) return '';

    const toolNames = schemas.map(s => s.name).join(', ');
    const skillRules = schemas.some(s => s.name === 'skill_view') ? `
SKILL RULES ARE HARD REQUIREMENTS:
- If the system prompt says a skill MUST be loaded, you MUST call skill_view before answering.
- If the user asks about Hermes Agent setup/config/providers/models/tools/skills/gateway/plugins/troubleshooting, FIRST call:
  {"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}}]}
- If a task is related to any listed skill category, call skill_view with the most relevant skill name before giving the final answer.
- After receiving a skill_view result, use it, then continue normally or call the next needed tool.
` : '';

    return `

OPENAI-COMPATIBLE TOOL CALLING ADAPTER ACTIVE.
You are behind a proxy that converts your JSON into real OpenAI tool_calls. Native prose like "I will use X" is NOT a tool call.

Available tool names exactly:
${toolNames}

${skillRules}
GENERAL TOOL RULES:
- When an action, lookup, file read/write, command, web search, calculation, or verification is needed, CALL A TOOL instead of describing the action.
- If the user asks you to do something, and a suitable tool exists, respond with a tool call first.
- Never invent tool results. After tool results appear in the conversation, use them to continue.
- Use exact tool names from the list above. Do not prefix names with namespaces.

TOOL CALL OUTPUT FORMAT — respond ONLY with a machine-readable tool block, no prose.
Preferred JSON:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}

Multiple calls are allowed:
{"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}},{"name":"terminal","arguments":{"command":"pwd"}}]}

If JSON escaping is risky, use this DSML fallback exactly:
<|DSML|tool_calls><|DSML|invoke name="tool_name"><|DSML|parameter name="arg">value</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>
Use CDATA for multiline/code/file content:
<|DSML|parameter name="content"><![CDATA[multiline text]]></|DSML|parameter>

Supported fallback shapes are parsed, but the JSON format above is preferred.

Compact tool schemas:
${JSON.stringify(schemas.map(({priority, ...schema}) => schema), null, 2)}

If no tool is needed and no skill rule applies, answer normally.`;
}
function limitSystemMessageForQwen(systemMessage) {
    const maxChars = Number.parseInt(process.env.QWEN_MAX_SYSTEM_CHARS || '', 10);
    const text = String(systemMessage || '');
    if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return systemMessage;

    // Keep the beginning (persona/safety) and the end (tool adapter/schema). The
    // middle is usually long skill catalogs/memories, and very large system
    // prompts can trigger Qwen web anti-bot responses before generation starts.
    const marker = `\n\n[FreeQwenApi truncated ${text.length - maxChars} system-prompt chars to stay under QWEN_MAX_SYSTEM_CHARS=${maxChars}]\n\n`;
    const remaining = Math.max(0, maxChars - marker.length);
    const head = Math.ceil(remaining * 0.45);
    const tail = remaining - head;
    return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function applyToolPrompt(systemMessage, tools) {
    const prompt = toolsToPrompt(tools);
    const toolAwareSystemMessage = prompt ? `${systemMessage || ''}${prompt}`.trim() : systemMessage;
    return limitSystemMessageForQwen(toolAwareSystemMessage);
}

function anthropicTextFromContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content);

    return content.map(block => {
        if (!block) return '';
        if (typeof block === 'string') return block;
        if (block.type === 'text') return block.text || '';
        if (block.type === 'tool_result') {
            const value = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
            return `Tool result (${block.tool_use_id || 'tool'}): ${value}`;
        }
        if (block.type === 'tool_use') {
            return `Assistant tool call: ${JSON.stringify({ name: block.name, input: block.input || {}, id: block.id })}`;
        }
        return JSON.stringify(block);
    }).filter(Boolean).join('\n');
}

function anthropicMessagesToOpenAI(body) {
    const messages = [];
    if (body.system) {
        messages.push({ role: 'system', content: anthropicTextFromContent(body.system) });
    }

    for (const msg of body.messages || []) {
        if (!msg) continue;
        const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
        const toolUseBlocks = content.filter(block => block?.type === 'tool_use');
        const toolResultBlocks = content.filter(block => block?.type === 'tool_result');
        const text = anthropicTextFromContent(content.filter(block => block?.type !== 'tool_use'));

        if (msg.role === 'assistant' && toolUseBlocks.length > 0) {
            messages.push({
                role: 'assistant',
                content: text || null,
                tool_calls: toolUseBlocks.map(block => ({
                    id: block.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'function',
                    function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
                }))
            });
            continue;
        }

        if (toolResultBlocks.length > 0) {
            for (const block of toolResultBlocks) {
                messages.push({
                    role: 'tool',
                    tool_call_id: block.tool_use_id || 'tool',
                    content: anthropicTextFromContent(block.content)
                });
            }
            const onlyToolResults = content.every(block => block?.type === 'tool_result');
            if (!onlyToolResults && text) messages.push({ role: 'user', content: text });
            continue;
        }

        messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
    return messages;
}

function anthropicToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) return undefined;
    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {} }
        }
    })).filter(tool => tool.function.name);
}

function openAIToAnthropicMessage(openAIJson, requestedModel) {
    const choice = openAIJson?.choices?.[0] || {};
    const message = choice.message || {};
    const content = [];

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        for (const call of message.tool_calls) {
            let input = {};
            try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
            content.push({
                type: 'tool_use',
                id: call.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                name: call.function?.name,
                input
            });
        }
    }

    if (message.content) content.push({ type: 'text', text: message.content });
    if (content.length === 0) content.push({ type: 'text', text: '' });

    return {
        id: openAIJson?.id || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'message',
        role: 'assistant',
        model: openAIJson?.model || requestedModel || DEFAULT_MODEL,
        content,
        stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: openAIJson?.usage?.prompt_tokens || 0,
            output_tokens: openAIJson?.usage?.completion_tokens || 0
        }
    };
}

function writeAnthropicStream(res, message) {
    const write = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    write('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null } });
    message.content.forEach((block, index) => {
        if (block.type === 'tool_use') {
            write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
            write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
        } else {
            write('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
            write('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text || '' } });
        }
        write('content_block_stop', { type: 'content_block_stop', index });
    });
    write('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage?.output_tokens || 0 } });
    write('message_stop', { type: 'message_stop' });
    res.end();
}

async function handleAnthropicMessages(req, res) {
    try {
        const body = req.body || {};
        logInfo(`Получен Anthropic-compatible Messages запрос${body.stream ? ' (stream)' : ''}`);
        const openAiBody = {
            model: body.model || DEFAULT_MODEL,
            messages: anthropicMessagesToOpenAI(body),
            tools: anthropicToolsToOpenAI(body.tools),
            tool_choice: body.tool_choice?.type === 'tool' ? { type: 'function', function: { name: body.tool_choice.name } } : body.tool_choice,
            stream: false,
            max_tokens: body.max_tokens,
            temperature: body.temperature
        };

        const loopbackHost = HOST === '::1' || HOST === '::' ? '[::1]' : '127.0.0.1';
        const url = `http://${loopbackHost}:${PORT}/api/chat/completions`;
        const loopbackHeaders = { 'Content-Type': 'application/json', 'x-force-new-chat': '1' };
        const inboundAuthorization = req.get('authorization');
        if (inboundAuthorization) loopbackHeaders.Authorization = inboundAuthorization;
        const upstream = await fetch(url, {
            method: 'POST',
            // The already-validated bearer stays request-local and is forwarded
            // only across this loopback auth boundary.
            headers: loopbackHeaders,
            body: JSON.stringify(openAiBody)
        });
        const openAIJson = await upstream.json();
        if (!upstream.ok) return res.status(upstream.status).json({ type: 'error', error: { type: 'api_error', message: openAIJson?.error || 'upstream error' } });
        const anthropicMessage = openAIToAnthropicMessage(openAIJson, body.model);

        if (body.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            return writeAnthropicStream(res, anthropicMessage);
        }
        res.json(anthropicMessage);
    } catch (error) {
        logError('Ошибка Anthropic-compatible Messages запроса', error);
        res.status(500).json({ type: 'error', error: { type: 'api_error', message: error.message || 'internal error' } });
    }
}

function buildOpenAIToolResponse(result, mappedModel, toolCalls) {
    return {
        id: result.id || 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || DEFAULT_MODEL,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCalls.map(({ index, ...call }) => call)
            },
            finish_reason: 'tool_calls'
        }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        chatId: result.chatId,
        parentId: result.parentId || result.response_id,
        x_qwen_chat_id: result.chatId,
        x_qwen_parent_id: result.parentId || result.response_id
    };
}

function wantsOpenAIStreamUsage(body = {}) {
    return body?.stream_options?.include_usage === true || body?.streamOptions?.includeUsage === true;
}

function writeOpenAIUsageSse(res, base, usage = null) {
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }) + '\n\n');
}

function writeToolCallsSse(res, mappedModel, result, toolCalls, includeUsage = false) {
    const base = {
        id: result.id || 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || DEFAULT_MODEL
    };
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    }) + '\n\n');
    for (const call of toolCalls) {
        res.write('data: ' + JSON.stringify({
            ...base,
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: call.index,
                        id: call.id,
                        type: 'function',
                        function: call.function
                    }]
                },
                finish_reason: null
            }]
        }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    }) + '\n\n');
    if (includeUsage) writeOpenAIUsageSse(res, base, result.usage);
    safeEndSse(res);
}

// ─── Helpers: streaming ──────────────────────────────────────────────────────

/** Пустая обёртка tool-call ({'tool_calls': []} без текста)? Qwen иногда отвечает
 *  ей вместо обычного текста — такой ответ нечем показать, нужен повтор без tools. */
function isEmptyToolEnvelope(content) {
    const text = String(content || '').trim();
    if (!text) return false;
    try {
        const parsed = JSON.parse(text);
        return Boolean(parsed && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length === 0 &&
            Object.keys(parsed).every(k => k === 'tool_calls'));
    } catch {
        return /^\s*\{\s*"tool_calls"\s*:\s*\[\s*\]\s*\}\s*$/.test(text);
    }
}

/**
 * Отправка plain-text ответа кусками (16 символов) с задержкой STREAMING_CHUNK_DELAY.
 * Используется в fallback, когда Qwen вернул JSON/обычный ответ вместо SSE:
 * без этого весь текст уходил бы одним мгновенным чанком (для OpenCode и др.).
 */
async function streamContentInChunks(res, writeSse, content, mappedModel, chunkSize = 16) {
    const codePoints = Array.from(String(content || ''));
    for (let i = 0; i < codePoints.length; i += chunkSize) {
        writeSse({
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: mappedModel || DEFAULT_MODEL,
            choices: [{
                index: 0,
                delta: { content: codePoints.slice(i, i + chunkSize).join('') },
                finish_reason: null
            }]
        });
        await new Promise(r => setTimeout(r, STREAMING_CHUNK_DELAY));
    }
}

async function handleStreamingResponse(res, mappedModel, messageContent, chatId, parentId, combinedTools, toolChoice, systemMessage) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const writeSse = (payload) => {
        if (res.destroyed || res.writableEnded) return;
        res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    writeSse({
        id: 'chatcmpl-stream', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: mappedModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    });

    try {
        const result = await sendMessage(messageContent, mappedModel, chatId, parentId, null, combinedTools, toolChoice, systemMessage);

        if (result.error) {
            writeSse({
                id: 'chatcmpl-stream', object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model: mappedModel,
                choices: [{ index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: null }]
            });
        } else if (result.choices?.[0]?.message) {
            const content = String(result.choices[0].message.content || '');
            const codePoints = Array.from(content);
            const chunkSize = 16;
            for (let i = 0; i < codePoints.length; i += chunkSize) {
                writeSse({
                    id: 'chatcmpl-stream', object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model: mappedModel,
                    choices: [{ index: 0, delta: { content: codePoints.slice(i, i + chunkSize).join('') }, finish_reason: null }]
                });
                await new Promise(r => setTimeout(r, STREAMING_CHUNK_DELAY));
            }
        }

        writeSse({
            id: 'chatcmpl-stream', object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: mappedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        });
        safeEndSse(res);
    } catch (error) {
        logError('Ошибка при обработке потокового запроса', error);
        writeSse({
            id: 'chatcmpl-stream', object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: mappedModel,
            choices: [{ index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }]
        });
        safeEndSse(res);
    }
}

function handleNonStreamingResponse(res, result, mappedModel) {
    if (result.error) {
        return sendApiResultError(res, result, { openAI: true });
    }

    res.json({
        id: result.id || 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel,
        choices: result.choices || [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        chatId: result.chatId,
        parentId: result.parentId
    });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
    try {
        const signal = withClientAbortSignal(res);
        const { message, messages, model, chatId, parentId, stream, chatType, size, waitForCompletion } = req.body;

        // Поддержка как message, так и messages для совместимости
        let messageContent = message;
        let systemMessage = null;
        let allMessages = messages; // Сохраняем всю историю
        const isMeta = isOpenWebUiMetaRequest(messages);

        if (messages && Array.isArray(messages)) {
            const parsed = parseOpenAIMessages(messages);
            systemMessage = parsed.systemMessage;
            if (parsed.messageContent) messageContent = parsed.messageContent;
        }

        if (!messageContent) {
            logError('Запрос без сообщения');
            return res.status(400).json({ error: 'Сообщение не указано' });
        }

        const filePreflight = preflightFileRequest(messageContent, null, getSessionKey(req));
        if (filePreflight.error) return sendApiResultError(res, filePreflight);

        logInfo(`Получен запрос: ${typeof messageContent === 'string' ? messageContent.substring(0, 50) + (messageContent.length > 50 ? '...' : '') : 'Составное сообщение'}`);
        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }
        if (chatId && !isMeta) {
            logInfo(`Используется chatId: ${chatId}, parentId: ${parentId || 'null'}`);
        } else if (isMeta) {
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }
        if (allMessages && allMessages.length > 1) {
            logInfo(`История содержит ${allMessages.length} сообщений`);
        }
        const resetMessageContent = Array.isArray(allMessages)
            && allMessages.filter(item => item && item.role !== 'system').length > 1
            ? buildStatelessTranscript(allMessages)
            : null;

        let mappedModel = model || DEFAULT_MODEL;
        if (model) {
            mappedModel = getMappedModel(model);
            if (mappedModel !== model) {
                logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
            }
        }
        logInfo(`Используется модель: ${mappedModel}`);
        const effectiveChatId = isMeta ? null : scopeClientChatId(chatId, req);
        const effectiveParentId = isMeta ? null : parentId;

        // Поддержка стриминга для OpenWebUI
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            // Важно для OpenWebUI - не кэшировать
            res.setHeader('X-Accel-Buffering', 'no');

            const writeSse = (payload) => {
                if (res.destroyed || res.writableEnded) return;
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                const qwenChatId = await resolveQwenChatId(effectiveChatId);
                // Setup streaming callback
                let streamingCallback = null;
                let hasStreamedChunks = false;
                let streamedText = '';
                let finalAssistantContent = ''; // ответ ассистента для транскрипта беседы
                if (stream) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        // Qwen отдаёт весь ответ одним SSE-событием — накапливаем и
                        // пере-чанкуем ниже, чтобы вывод шёл постепенно.
                        streamedText += chunk;
                    };
                }

                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    qwenChatId,
                    effectiveParentId,
                    null,
                    null,
                    null,
                    systemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback,
                    resetMessageContent,
                    getSessionKey(req),
                    signal
                );

                if (!isMeta && result.chatId) {
                    persistRequestChatIdentity(effectiveChatId, result.chatId, qwenChatId, req);
                }

                if (result.error && !res.headersSent) {
                    return sendApiResultError(res, result);
                }
                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-' + Date.now(),
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || DEFAULT_MODEL,
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: 'stop' }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    // Qwen вернул JSON/обычный ответ вместо SSE — стримим контент
                    // кусками с задержкой, чтобы ответ появлялся постепенно, а не
                    // одним мгновенным чанком (важно для OpenCode, который шлёт tools).
                    let content = String(result.choices[0].message.content || '');
                    if (isEmptyToolEnvelope(content)) {
                        // Qwen ответил пустой обёрткой {"tool_calls":[]} без текста —
                        // повторяем запрос БЕЗ tools, чтобы получить обычный ответ.
                        logWarn('Qwen вернул пустую обёртку tool_calls — повторяем запрос без tools');
                        const retried = await sendMessage(
                            messageContent,
                            mappedModel,
                            qwenChatId,
                            effectiveParentId,
                            files,
                            null,
                            null,
                            systemMessage, // БЕЗ tool-адаптера, иначе Qwen снова вернёт обёртку
                            't2t',
                            null,
                            true,
                            0,
                            null,
                            preparedInput.resetMessageContent,
                            getSessionKey(req),
                            signal
                        );
                        if (retried.error) {
                            writeSse({
                                id: 'chatcmpl-stream',
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: mappedModel || DEFAULT_MODEL,
                                choices: [{ index: 0, delta: { content: `Ошибка: ${retried.error}` }, finish_reason: 'stop' }]
                            });
                            safeEndSse(res);
                            return;
                        }
                        content = String(retried?.choices?.[0]?.message?.content || '');
                        if (isEmptyToolEnvelope(content)) content = '';
                    }
                    finalAssistantContent = content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (content) {
                        await streamContentInChunks(res, writeSse, content, mappedModel);
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }
                // Qwen отдаёт ответ одним SSE-событием: стримим накопленный текст
                // кусками с задержкой, чтобы клиент видел прогрессивный вывод.
                if (hasStreamedChunks && streamedText) {
                    finalAssistantContent = streamedText;
                    await streamContentInChunks(res, writeSse, streamedText, mappedModel);
                }

                // Финальный чанк
                writeSse({
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                safeEndSse(res);
                return;
            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                safeEndSse(res);
                return;
            }
        }

        const qwenChatId = await resolveQwenChatId(effectiveChatId);
        const result = await sendMessage(
            messageContent,
            mappedModel,
            qwenChatId,
            effectiveParentId,
            null,
            null,
            null,
            systemMessage,
            chatType || 't2t',
            size || null,
            waitForCompletion ?? true,
            0,
            null,
            resetMessageContent,
            getSessionKey(req),
            signal
        );

        if (!isMeta && result.chatId) {
            persistRequestChatIdentity(effectiveChatId, result.chatId, qwenChatId, req);
        }

        if (result.choices && result.choices[0] && result.choices[0].message) {
            const responseLength = result.choices[0].message.content ? result.choices[0].message.content.length : 0;
            logInfo(`Ответ успешно сформирован для запроса, длина ответа: ${responseLength}`);
            
            // Сохраняем историю чата
            if (result.chatId) {
                try {
                    const currentChat = loadHistory(result.chatId);
                    const updatedMessages = allMessages || [
                        { role: 'user', content: messageContent },
                        { role: 'assistant', content: result.choices[0].message.content }
                    ];
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }
        } else if (result.error) {
            logInfo(`Получена ошибка в ответе: ${result.error}`);
            return sendApiResultError(res, result);
        }

        res.json(result);
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/health', async (req, res) => {
    try {
        const modelData = getAllModels();
        const tokens = listTokens();
        const now = Date.now();
        const availableAccounts = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid).length;

        res.json({
            ok: availableAccounts > 0,
            service: 'FreeQwenApi',
            watermark: FORGETMEAI_WATERMARK,
            baseUrl: '/api',
            models: modelData.models.length,
            accounts: {
                total: tokens.length,
                available: availableAccounts,
                invalid: tokens.filter(t => t.invalid).length,
                waiting: tokens.filter(t => t.resetAt && new Date(t.resetAt).getTime() > now).length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logError('Ошибка health check', error);
        res.status(500).json({ ok: false, error: 'Health-проверка не удалась' });
    }
});

router.get('/models', async (req, res) => {
    try {
        logInfo('Запрос на получение списка моделей');
        const modelsRaw = getAllModels();
        const openAiModels = {
            object: 'list',
            data: modelsRaw.models.map(m => ({
                id: m.id || m.name || m,
                object: 'model',
                created: 0,
                owned_by: 'qwen',
                permission: []
            }))
        };
        logInfo(`Возвращено ${openAiModels.data.length} моделей (OpenAI формат)`);
        res.json(openAiModels);
    } catch (error) {
        logError('Ошибка при получении списка моделей', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/v1/messages', handleAnthropicMessages);
router.post('/messages', handleAnthropicMessages);

router.get('/status', async (req, res) => {
    try {
        logInfo('Запрос статуса авторизации');
        const tokens = listTokens();
        const now = Date.now();
        const accounts = [];

        for (const t of tokens) {
            const accInfo = { id: t.id, status: 'UNKNOWN', resetAt: t.resetAt || null };

            if (t.resetAt && new Date(t.resetAt).getTime() > now) { accInfo.status = 'WAIT'; accounts.push(accInfo); continue; }
            if (t.invalid) { accInfo.status = 'INVALID'; accounts.push(accInfo); continue; }

            // Живая проверка с кэшем: повторные запросы в пределах TTL не бьют в Qwen.
            const live = await checkQwenAuthLive(t.token);
            if (live.status === 'ok') { accInfo.status = 'OK'; if (t.invalid || t.resetAt) markValid(t.id); }
            else if (live.status === 'ratelimit') { accInfo.status = 'WAIT'; markRateLimited(t.id); }
            else if (live.status === 'unauthorized') { accInfo.status = 'INVALID'; if (!t.invalid) markInvalid(t.id); }
            else { accInfo.status = 'ERROR'; }
            accInfo.live = live;
            accounts.push(accInfo);
        }

        const browserContext = getBrowserContext();
        if (!browserContext) {
            logError('Браузер не инициализирован');
            return res.json({ authenticated: false, message: 'Браузер не инициализирован', accounts });
        }

        const browserToken = getAuthToken();
        let authenticated = getAuthenticationStatus();
        let message = authenticated ? 'Авторизация активна' : 'Требуется авторизация';
        let live = null;

        if (browserToken) {
            // Реальная проверка текущей сессии Qwen (кэш + лёгкий retry).
            live = await checkQwenAuthLive(browserToken);
            if (live.status === 'ok' || live.status === 'ratelimit') {
                authenticated = true;
                message = 'Авторизация активна';
            } else if (live.status === 'unauthorized') {
                authenticated = false;
                message = 'Сессия Qwen истекла (401): требуется повторная авторизация';
            } else {
                // Транзиентная ошибка проверки — показываем состояние флага браузера.
                message = 'Не удалось проверить сессию (транзиентная ошибка)';
            }
        } else if (!authenticated) {
            await checkAuthentication(browserContext);
            authenticated = getAuthenticationStatus();
            message = authenticated ? 'Авторизация активна' : 'Требуется авторизация';
        }

        logInfo(`Статус авторизации: ${authenticated ? 'активна' : 'требуется авторизация'}${live ? ` (live: ${live.status})` : ''}`);
        res.json({ authenticated, message, accounts, live });
    } catch (error) {
        logError('Ошибка при проверке статуса авторизации', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/chats', async (req, res) => {
    try {
        const { name, model } = req.body;
        const chatModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        logInfo(`Создание нового чата${name ? ` с именем: ${name}` : ''}, модель: ${chatModel}`);
        const result = await createChatV2(chatModel, name || 'Новый чат');
        if (result.error) { logError(`Ошибка создания чата: ${result.error}`); return res.status(500).json({ error: result.error }); }
        registerClientUpstreamChatId(result.chatId, getSessionKey(req));
        logInfo(`Создан новый чат v2 с ID: ${result.chatId}`);
        res.json({ chatId: result.chatId, success: true });
    } catch (error) {
        logError('Ошибка при создании чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/chat/completions', (req, res) => {
    res.status(405).json({
        error: 'Метод не поддерживается',
        message: 'Используйте POST /api/chat/completions'
    });
});

router.post('/chat/completions', async (req, res) => {
    try {
        const signal = withClientAbortSignal(res);
        const { messages, model, stream, tools, functions, tool_choice, chatId } = req.body;
        const snakeCaseChatId = normalizeIdValue(req.body?.chat_id);
        const explicitChatId = normalizeIdValue(chatId) || snakeCaseChatId;
        const explicitParentId = extractParentHint(req);
        const conversationHint = extractConversationHint(req);
        const conversationScope = conversationHint ? `conversation:${conversationHint}` : null;
        const forceNewChat = shouldForceNewChat(req);
        logInfo(`Получен OpenAI-совместимый запрос${stream ? ' (stream)' : ''}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return res.status(400).json({ error: 'Сообщения не указаны' });
        }

        const isMeta = isOpenWebUiMetaRequest(messages);

        // Используем переданный chatId ИЛИ восстанавливаем из сессии
        let effectiveChatId = scopeClientChatId(explicitChatId, req);
        let effectiveParentId = explicitParentId;
        let historyDerived = false; // effectiveChatId получен из истории (не от клиента)

        if (forceNewChat && !explicitChatId && !isMeta) {
            effectiveChatId = `chat_${crypto.randomBytes(8).toString('hex')}`;
            effectiveParentId = null;
            logInfo(`Принудительно запрошен новый чат (newChat/resetChat): ${effectiveChatId}`);
        }

        if (!effectiveChatId && !isMeta) {
            if (conversationHint) {
                const scopedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (scopedSession?.chatId) {
                    effectiveChatId = scopedSession.chatId;
                    if (!effectiveParentId && scopedSession.parentId) {
                        effectiveParentId = scopedSession.parentId;
                    }
                    logInfo(`Restored scoped chatId from session: ${effectiveChatId}`);
                } else {
                    effectiveChatId = buildInternalChatIdFromHint(conversationHint, req);
                    logInfo(`Using client conversation-id key: ${effectiveChatId}`);
                }
            } else if (ALLOW_UNSCOPED_SESSION_CHAT_RESTORE) {
                // История-детерминированный id в приоритете: он стабилен для одной
                // беседы (по первому сообщению пользователя) и не смешивает разные
                // беседы одного клиента (в отличие от сессии по IP+UA).
                const generatedId = generateChatIdFromHistory(messages, req);
                if (generatedId) {
                    effectiveChatId = generatedId;
                    historyDerived = true;
                    logInfo(`Created chatId from conversation history: ${effectiveChatId}`);
                } else {
                    const savedSession = forceNewChat ? null : getSavedChatId(req);
                    if (savedSession?.chatId) {
                        effectiveChatId = savedSession.chatId;
                        if (!effectiveParentId && savedSession.parentId) {
                            effectiveParentId = savedSession.parentId;
                        }
                        logInfo(`Restored chatId from session: ${effectiveChatId}`);
                    }
                }
            } else {
                logDebug('chatId/conversation_id не переданы, unscoped session fallback отключён');
            }
        }

        // Fork-логика для history-derived id: беседа переиспользуется ТОЛЬКО при
        // непрерывности транскрипта (входящая история — прямое продолжение сохранённой).
        // Иначе создаётся отдельная беседа (fork) — сессии с одинаковым первым
        // сообщением не смешивают контекст друг друга.
        let forkedTranscript = null;
        if (historyDerived && effectiveChatId) {
            const incomingKeys = sequenceKeys(messages);
            const continuationId = chatTranscriptStore.findContinuation(effectiveChatId, incomingKeys);
            if (continuationId) {
                effectiveChatId = continuationId;
                chatTranscriptStore.appendDiff(effectiveChatId, incomingKeys, messages);
            } else {
                effectiveChatId = chatTranscriptStore.fork(effectiveChatId, incomingKeys, messages);
                logInfo(`Новая fork-беседа: ${effectiveChatId} (${incomingKeys.length} сообщений)`);
            }
            forkedTranscript = chatTranscriptStore.buildWindowedTranscript(effectiveChatId);
            if (forkedTranscript) {
                logDebug(`Контекст беседы ${effectiveChatId} свёрнут из транскрипта прокси (${forkedTranscript.length} симв.)`);
            }
        }

        // Извлекаем system message если есть
        const systemMsg = messages.find(msg => msg.role === 'system');
        const systemMessage = systemMsg ? systemMsg.content : null;
        const { combinedTools } = buildCombinedTools(tools, functions, tool_choice);

        const preparedInput = prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId);
        if (preparedInput.missingUser) {
            logError('В запросе нет сообщений от пользователя');
            return res.status(400).json({ error: 'В запросе нет сообщений от пользователя' });
        }

        let messageContent = preparedInput.messageContent;
        
        // Преобразуем OpenAI format content array во внутренний формат
        if (Array.isArray(messageContent)) {
            messageContent = messageContent.map(item => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                } else if (item.type === 'image_url' && item.image_url) {
                    // OpenAI format: image_url: { url: '...' }
                    return { type: 'image', image: item.image_url.url };
                } else if (item.type === 'image') {
                    // Уже во внутреннем формате
                    return { type: 'image', image: item.image };
                }
                return item;
            });
        }
        
        const files = preparedInput.files || []; // ← ИЗВЛЕКАЕМ FILES
        const filePreflight = preflightFileRequest(messageContent, files, getSessionKey(req));
        if (filePreflight.error) {
            return sendApiResultError(res, filePreflight, { openAI: true });
        }
        if (preparedInput.folded) {
            logInfo('OpenAI/Hermes transcript folded into user message for context/tool-result preservation');
        }
        // Для history-derived бесед подставляем оконный fold из собственного транскрипта
        // (если клиент сам не свернул контекст): контекст переживает свап аккаунта
        // независимо от payload клиента, а размер свёртки ограничен.
        if (forkedTranscript && !preparedInput.folded) {
            preparedInput.resetMessageContent = forkedTranscript;
        }

        if (isMeta) {
            effectiveChatId = null;
            effectiveParentId = null;
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }

        let mappedModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        if (model && mappedModel !== model) {
            logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
        }
        logInfo(`Используется модель: ${mappedModel}`);
        if (systemMessage) logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);

        const qwenTools = null; // Qwen Chat web API не умеет OpenAI tool schemas; эмулируем через JSON prompt ниже.
        const toolAwareSystemMessage = applyToolPrompt(systemMessage, combinedTools);

        if (toolAwareSystemMessage) {
            logInfo(`System message: ${toolAwareSystemMessage.substring(0, 50)}${toolAwareSystemMessage.length > 50 ? '...' : ''}`);
        }

        // Логируем полную историю сообщений
        logInfo(`История содержит ${messages.length} сообщений: ${messages.map(m => m.role).join(', ')}`);
        if (effectiveChatId) {
            logInfo(`Используется chatId: ${effectiveChatId}, parentId: ${effectiveParentId || 'null'}`);
        }

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Transfer-Encoding', 'chunked');

            const writeSse = (payload) => {
                if (res.destroyed || res.writableEnded) return;
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                const qwenChatId = await resolveQwenChatId(effectiveChatId);

                // Setup streaming callback if stream=true
                let streamingCallback = null;
                let hasStreamedChunks = false;
                let streamedText = '';
                let finalAssistantContent = ''; // ответ ассистента для транскрипта беседы
                const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;
                if (stream && !captureToolCalls) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        // Qwen отдаёт весь ответ одним SSE-событием — накапливаем и
                        // пере-чанкуем ниже (streamContentInChunks), чтобы вывод шёл
                        // постепенно, а не одним мгновенным куском.
                        streamedText += chunk;
                    };
                }

                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    qwenChatId,
                    effectiveParentId,
                    files, // ← ПЕРЕДАЁМ FILES
                    qwenTools,
                    tool_choice,
                    toolAwareSystemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback,
                    preparedInput.resetMessageContent,
                    getSessionKey(req),
                    signal
                );

                // Persist ownership before any response path can return early
                // (notably parsed tool-call streams).
                if (!isMeta && result.chatId) {
                    persistRequestChatIdentity(effectiveChatId, result.chatId, qwenChatId, req);
                    if (shouldPersistSessionContext(conversationScope)) {
                        saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                    }
                }

                if (result.error && !res.headersSent) {
                    return sendApiResultError(res, result, { openAI: true });
                }
                if (captureToolCalls) {
                    const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content);
                    if (toolCalls && toolCalls.length > 0) {
                        writeToolCallsSse(res, mappedModel, result, toolCalls, wantsOpenAIStreamUsage(req.body));
                        return;
                    }
                }

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-stream',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || DEFAULT_MODEL,
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: null }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    // Qwen вернул JSON/обычный ответ вместо SSE — стримим контент
                    // кусками с задержкой, чтобы ответ появлялся постепенно, а не
                    // одним мгновенным чанком (важно для OpenCode, который шлёт tools).
                    let content = String(result.choices[0].message.content || '');
                    if (isEmptyToolEnvelope(content)) {
                        // Qwen ответил пустой обёрткой {"tool_calls":[]} без текста —
                        // повторяем запрос БЕЗ tools, чтобы получить обычный ответ.
                        logWarn('Qwen вернул пустую обёртку tool_calls — повторяем запрос без tools');
                        const retried = await sendMessage(
                            messageContent,
                            mappedModel,
                            qwenChatId,
                            effectiveParentId,
                            files,
                            null,
                            null,
                            systemMessage, // БЕЗ tool-адаптера, иначе Qwen снова вернёт обёртку
                            't2t',
                            null,
                            true,
                            0,
                            null,
                            preparedInput.resetMessageContent,
                            getSessionKey(req),
                            signal
                        );
                        if (retried.error) {
                            writeSse({
                                id: 'chatcmpl-stream',
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: mappedModel || DEFAULT_MODEL,
                                choices: [{ index: 0, delta: { content: `Ошибка: ${retried.error}` }, finish_reason: 'stop' }]
                            });
                            safeEndSse(res);
                            return;
                        }
                        content = String(retried?.choices?.[0]?.message?.content || '');
                        if (isEmptyToolEnvelope(content)) content = '';
                    }
                    finalAssistantContent = content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (content) {
                        await streamContentInChunks(res, writeSse, content, mappedModel);
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }
                // Qwen отдаёт ответ одним SSE-событием: стримим накопленный текст
                // кусками с задержкой, чтобы клиент видел прогрессивный вывод.
                if (hasStreamedChunks && streamedText) {
                    finalAssistantContent = streamedText;
                    await streamContentInChunks(res, writeSse, streamedText, mappedModel);
                }

                const finalBase = {
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL
                };
                writeSse({
                    ...finalBase,
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                if (wantsOpenAIStreamUsage(req.body)) writeOpenAIUsageSse(res, finalBase, result.usage);
                if (historyDerived && effectiveChatId && finalAssistantContent) {
                    chatTranscriptStore.appendAssistant(effectiveChatId, finalAssistantContent);
                }
                safeEndSse(res);

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                safeEndSse(res);
            }
        } else {
            const qwenChatId = await resolveQwenChatId(effectiveChatId);
            const result = await sendMessage(
                messageContent,
                mappedModel,
                qwenChatId,
                effectiveParentId,
                files,
                qwenTools,
                tool_choice,
                toolAwareSystemMessage,
                't2t',
                null,
                true,
                0,
                null,
                preparedInput.resetMessageContent,
                getSessionKey(req),
                signal
            );

            // Сохраняем chatId в сессию для следующих запросов
            if (!isMeta && result.chatId) {
                persistRequestChatIdentity(effectiveChatId, result.chatId, qwenChatId, req);
                if (shouldPersistSessionContext(conversationScope)) {
                    saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                }
            }

            if (result.error) {
                return sendApiResultError(res, result, { openAI: true });
            }
            if (historyDerived && effectiveChatId && result?.choices?.[0]?.message?.content) {
                chatTranscriptStore.appendAssistant(effectiveChatId, result.choices[0].message.content);
            }

            const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content);
            if (toolCalls && toolCalls.length > 0) {
                return res.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
            }

            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || mappedModel || DEFAULT_MODEL,
                choices: result.choices || [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.choices?.[0]?.message?.content || ""
                    },
                    finish_reason: "stop"
                }],
                usage: result.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                chatId: result.chatId,
                parentId: result.parentId
            };

            // Сохраняем историю чата
            if (result.chatId) {
                try {
                    const currentChat = loadHistory(result.chatId);
                    const responseMessage = {
                        role: 'assistant',
                        content: openaiResponse.choices[0].message.content
                    };
                    const updatedMessages = messages.concat([responseMessage]);
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }

            res.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } });
    }
});

// OpenAI совместимый эндпоинт v1 (для Open WebUI и других клиентов)
router.post('/v1/chat/completions', async (req, res) => {
    try {
        const signal = withClientAbortSignal(res);
        const { messages, model, stream, tools, functions, tool_choice, chatId } = req.body;
        const snakeCaseChatId = normalizeIdValue(req.body?.chat_id);
        const explicitChatId = normalizeIdValue(chatId) || snakeCaseChatId;
        const explicitParentId = extractParentHint(req);
        const conversationHint = extractConversationHint(req);
        const conversationScope = conversationHint ? `conversation:${conversationHint}` : null;
        const forceNewChat = shouldForceNewChat(req);

        logInfo(`Получен OpenAI v1 запрос${stream ? ' (stream)' : ''}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return res.status(400).json({ error: 'Сообщения не указаны' });
        }

        const isMeta = isOpenWebUiMetaRequest(messages);

        // Используем переданный chatId ИЛИ восстанавливаем из сессии
        let effectiveChatId = scopeClientChatId(explicitChatId, req);
        let effectiveParentId = explicitParentId;
        let historyDerived = false; // effectiveChatId получен из истории (не от клиента)

        if (forceNewChat && !explicitChatId && !isMeta) {
            effectiveChatId = `chat_${crypto.randomBytes(8).toString('hex')}`;
            effectiveParentId = null;
            logInfo(`Принудительно запрошен новый чат (newChat/resetChat): ${effectiveChatId}`);
        }

        if (!effectiveChatId && !isMeta) {
            if (conversationHint) {
                const scopedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (scopedSession?.chatId) {
                    effectiveChatId = scopedSession.chatId;
                    if (!effectiveParentId && scopedSession.parentId) {
                        effectiveParentId = scopedSession.parentId;
                    }
                    logInfo(`Restored scoped chatId from session: ${effectiveChatId}`);
                } else {
                    effectiveChatId = buildInternalChatIdFromHint(conversationHint, req);
                    logInfo(`Using client conversation-id key: ${effectiveChatId}`);
                }
            } else if (ALLOW_UNSCOPED_SESSION_CHAT_RESTORE) {
                // История-детерминированный id в приоритете: он стабилен для одной
                // беседы (по первому сообщению пользователя) и не смешивает разные
                // беседы одного клиента (в отличие от сессии по IP+UA).
                const generatedId = generateChatIdFromHistory(messages, req);
                if (generatedId) {
                    effectiveChatId = generatedId;
                    historyDerived = true;
                    logInfo(`Created chatId from conversation history: ${effectiveChatId}`);
                } else {
                    const savedSession = forceNewChat ? null : getSavedChatId(req);
                    if (savedSession?.chatId) {
                        effectiveChatId = savedSession.chatId;
                        if (!effectiveParentId && savedSession.parentId) {
                            effectiveParentId = savedSession.parentId;
                        }
                        logInfo(`Restored chatId from session: ${effectiveChatId}`);
                    }
                }
            } else {
                logDebug('chatId/conversation_id не переданы, unscoped session fallback отключён');
            }
        }

        // Fork-логика для history-derived id: беседа переиспользуется ТОЛЬКО при
        // непрерывности транскрипта (входящая история — прямое продолжение сохранённой).
        // Иначе создаётся отдельная беседа (fork) — сессии с одинаковым первым
        // сообщением не смешивают контекст друг друга.
        let forkedTranscript = null;
        if (historyDerived && effectiveChatId) {
            const incomingKeys = sequenceKeys(messages);
            const continuationId = chatTranscriptStore.findContinuation(effectiveChatId, incomingKeys);
            if (continuationId) {
                effectiveChatId = continuationId;
                chatTranscriptStore.appendDiff(effectiveChatId, incomingKeys, messages);
            } else {
                effectiveChatId = chatTranscriptStore.fork(effectiveChatId, incomingKeys, messages);
                logInfo(`Новая fork-беседа: ${effectiveChatId} (${incomingKeys.length} сообщений)`);
            }
            forkedTranscript = chatTranscriptStore.buildWindowedTranscript(effectiveChatId);
            if (forkedTranscript) {
                logDebug(`Контекст беседы ${effectiveChatId} свёрнут из транскрипта прокси (${forkedTranscript.length} симв.)`);
            }
        }

        // Извлекаем system message если есть
        const systemMsg = messages.find(msg => msg.role === 'system');
        const systemMessage = systemMsg ? systemMsg.content : null;
        const { combinedTools } = buildCombinedTools(tools, functions, tool_choice);

        const preparedInput = prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId);
        if (preparedInput.missingUser) {
            logError('В запросе нет сообщений от пользователя');
            return res.status(400).json({ error: 'В запросе нет сообщений от пользователя' });
        }

        let messageContent = preparedInput.messageContent;
        
        // Преобразуем OpenAI format content array во внутренний формат
        if (Array.isArray(messageContent)) {
            messageContent = messageContent.map(item => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                } else if (item.type === 'image_url' && item.image_url) {
                    // OpenAI format: image_url: { url: '...' }
                    return { type: 'image', image: item.image_url.url };
                } else if (item.type === 'image') {
                    // Уже во внутреннем формате
                    return { type: 'image', image: item.image };
                }
                return item;
            });
        }
        
        const files = preparedInput.files || []; // ← ИЗВЛЕКАЕМ FILES
        const filePreflight = preflightFileRequest(messageContent, files, getSessionKey(req));
        if (filePreflight.error) {
            return sendApiResultError(res, filePreflight, { openAI: true });
        }
        if (preparedInput.folded) {
            logInfo('OpenAI/Hermes transcript folded into user message for context/tool-result preservation');
        }
        // Для history-derived бесед подставляем оконный fold из собственного транскрипта
        // (если клиент сам не свернул контекст): контекст переживает свап аккаунта
        // независимо от payload клиента, а размер свёртки ограничен.
        if (forkedTranscript && !preparedInput.folded) {
            preparedInput.resetMessageContent = forkedTranscript;
        }

        if (isMeta) {
            effectiveChatId = null;
            effectiveParentId = null;
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }

        let mappedModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        if (model && mappedModel !== model) {
            logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
        }
        logInfo(`Используется модель: ${mappedModel}`);

        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }

        const qwenTools = null; // Qwen Chat web API не умеет OpenAI tool schemas; эмулируем через JSON prompt ниже.
        const toolAwareSystemMessage = applyToolPrompt(systemMessage, combinedTools);
        if (toolAwareSystemMessage) {
            logInfo(`System message: ${toolAwareSystemMessage.substring(0, 50)}${toolAwareSystemMessage.length > 50 ? '...' : ''}`);
        }

        // Логируем полную историю сообщений
        logInfo(`История содержит ${messages.length} сообщений: ${messages.map(m => m.role).join(', ')}`);
        if (effectiveChatId) {
            logInfo(`Используется chatId: ${effectiveChatId}, parentId: ${effectiveParentId || 'null'}`);
        }

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Transfer-Encoding', 'chunked');

            const writeSse = (payload) => {
                if (res.destroyed || res.writableEnded) return;
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                const qwenChatId = await resolveQwenChatId(effectiveChatId);

                // Setup streaming callback if stream=true
                let streamingCallback = null;
                let hasStreamedChunks = false;
                let streamedText = '';
                let finalAssistantContent = ''; // ответ ассистента для транскрипта беседы
                const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;
                if (stream && !captureToolCalls) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        // Qwen отдаёт весь ответ одним SSE-событием — накапливаем и
                        // пере-чанкуем ниже (streamContentInChunks), чтобы вывод шёл
                        // постепенно, а не одним мгновенным куском.
                        streamedText += chunk;
                    };
                }
                
                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    qwenChatId,
                    effectiveParentId,
                    files, // ← ИЗВЛЕКАЕМ FILES
                    qwenTools,
                    tool_choice,
                    toolAwareSystemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback,
                    preparedInput.resetMessageContent,
                    getSessionKey(req),
                    signal
                );

                // Persist ownership before any response path can return early
                // (notably parsed tool-call streams).
                if (!isMeta && result.chatId) {
                    persistRequestChatIdentity(effectiveChatId, result.chatId, qwenChatId, req);
                    if (shouldPersistSessionContext(conversationScope)) {
                        saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                    }
                }

                if (result.error && !res.headersSent) {
                    return sendApiResultError(res, result, { openAI: true });
                }
                if (captureToolCalls) {
                    const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content);
                    if (toolCalls && toolCalls.length > 0) {
                        writeToolCallsSse(res, mappedModel, result, toolCalls, wantsOpenAIStreamUsage(req.body));
                        return;
                    }
                }

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-stream',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || DEFAULT_MODEL,
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: 'stop' }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    // Qwen вернул JSON/обычный ответ вместо SSE — стримим контент
                    // кусками с задержкой, чтобы ответ появлялся постепенно, а не
                    // одним мгновенным чанком (важно для OpenCode, который шлёт tools).
                    let content = String(result.choices[0].message.content || '');
                    if (isEmptyToolEnvelope(content)) {
                        // Qwen ответил пустой обёрткой {"tool_calls":[]} без текста —
                        // повторяем запрос БЕЗ tools, чтобы получить обычный ответ.
                        logWarn('Qwen вернул пустую обёртку tool_calls — повторяем запрос без tools');
                        const retried = await sendMessage(
                            messageContent,
                            mappedModel,
                            qwenChatId,
                            effectiveParentId,
                            files,
                            null,
                            null,
                            systemMessage, // БЕЗ tool-адаптера, иначе Qwen снова вернёт обёртку
                            't2t',
                            null,
                            true,
                            0,
                            null,
                            preparedInput.resetMessageContent,
                            getSessionKey(req),
                            signal
                        );
                        if (retried.error) {
                            writeSse({
                                id: 'chatcmpl-stream',
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: mappedModel || DEFAULT_MODEL,
                                choices: [{ index: 0, delta: { content: `Ошибка: ${retried.error}` }, finish_reason: 'stop' }]
                            });
                            safeEndSse(res);
                            return;
                        }
                        content = String(retried?.choices?.[0]?.message?.content || '');
                        if (isEmptyToolEnvelope(content)) content = '';
                    }
                    finalAssistantContent = content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (content) {
                        await streamContentInChunks(res, writeSse, content, mappedModel);
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }
                // Qwen отдаёт ответ одним SSE-событием: стримим накопленный текст
                // кусками с задержкой, чтобы клиент видел прогрессивный вывод.
                if (hasStreamedChunks && streamedText) {
                    finalAssistantContent = streamedText;
                    await streamContentInChunks(res, writeSse, streamedText, mappedModel);
                }

                const finalBase = {
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL
                };
                writeSse({
                    ...finalBase,
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                if (wantsOpenAIStreamUsage(req.body)) writeOpenAIUsageSse(res, finalBase, result.usage);
                if (historyDerived && effectiveChatId && finalAssistantContent) {
                    chatTranscriptStore.appendAssistant(effectiveChatId, finalAssistantContent);
                }
                safeEndSse(res);

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                safeEndSse(res);
            }
        } else {
            const qwenChatId = await resolveQwenChatId(effectiveChatId);

            const result = await sendMessage(
                messageContent,
                mappedModel,
                qwenChatId,
                effectiveParentId,
                files,
                qwenTools,
                tool_choice,
                toolAwareSystemMessage,
                't2t',
                null,
                true,
                0,
                null,
                preparedInput.resetMessageContent,
                getSessionKey(req),
                signal
            );

            // Сохраняем chatId в сессии для следующих запросов
            if (!isMeta && result.chatId) {
                persistRequestChatIdentity(effectiveChatId, result.chatId, qwenChatId, req);
                if (shouldPersistSessionContext(conversationScope)) {
                    saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                }
            }

            if (result.error) {
                return sendApiResultError(res, result, { openAI: true });
            }
            if (historyDerived && effectiveChatId) {
                const replyText = result?.choices?.[0]?.message?.content
                    || (result.response && result.response.text ? result.response.text : '');
                if (replyText) chatTranscriptStore.appendAssistant(effectiveChatId, replyText);
            }

            // Извлекаем контент сообщения
            let messageText = '';
            if (result.choices && result.choices[0] && result.choices[0].message) {
                messageText = result.choices[0].message.content || '';
            } else if (result.response && result.response.text) {
                messageText = result.response.text;
            }

            const toolCalls = parseToolCallJson(messageText);
            if (toolCalls && toolCalls.length > 0) {
                return res.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
            }

            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || mappedModel || DEFAULT_MODEL,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: messageText
                    },
                    finish_reason: "stop"
                }],
                usage: result.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                // Передаём метаданные для сохранения контекста
                x_qwen_chat_id: result.chatId,
                x_qwen_parent_id: result.parentId || result.response_id
            };

            // Сохраняем историю чата для v1 эндпоинта
            if (result.chatId) {
                // Сохраняем chatId в сессии для последующих запросов от этого клиента
                if (!isMeta) {
                    try {
                        if (shouldPersistSessionContext(conversationScope)) {
                            saveChatIdForSession(req, result.chatId, result.parentId || result.response_id, conversationScope);
                        }
                    } catch (e) {
                        logDebug(`Не удалось сохранить chatId в сессии: ${e.message}`);
                    }
                }

                try {
                    const currentChat = loadHistory(result.chatId);
                    const responseMessage = {
                        role: 'assistant',
                        content: messageText
                    };
                    const updatedMessages = messages.concat([responseMessage]);
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }

            res.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке v1 запроса', error);
        res.status(500).json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } });
    }
});

router.post('/files/getstsToken', async (req, res) => {
    try {
        logInfo(`Запрос на получение STS токена: ${JSON.stringify(req.body)}`);
        const fileInfo = req.body;
        if (!fileInfo?.filename || !fileInfo?.filesize || !fileInfo?.filetype) {
            logError('Некорректные данные о файле');
            return res.status(400).json({ error: 'Некорректные данные о файле' });
        }
        res.json(await getStsToken(fileInfo, getSessionKey(req)));
    } catch (error) {
        logError('Ошибка при получении STS токена', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/files/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) { logError('Файл не был загружен'); return res.status(400).json({ error: 'Файл не был загружен' }); }
        logInfo(`Файл загружен на сервер: ${req.file.originalname} (${req.file.size} байт)`);

        const result = await uploadFileToQwen(req.file.path, getSessionKey(req));

        try { fs.unlinkSync(req.file.path); } catch { /* file already removed or inaccessible */ }

        if (result.success) {
            logInfo(`Файл успешно загружен в OSS: ${result.fileName}`);
            res.json({
                success: true,
                file: {
                    id: result.fileId,
                    fileId: result.fileId,
                    file_path: result.filePath,
                    name: result.fileName,
                    url: result.url,
                    size: req.file.size,
                    type: req.file.mimetype
                }
            });
        } else {
            logError(`Ошибка при загрузке файла в OSS: ${result.error}`);
            res.status(500).json({ error: 'Ошибка при загрузке файла' });
        }
    } catch (error) {
        logError('Ошибка при загрузке файла', error);
        if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для сохранения истории чата (для работы с Open WebUI)
router.post('/chats/:chatId/history', async (req, res) => {
    try {
        const { chatId } = req.params;
        const { messages } = req.body;

        logInfo(`Запрос сохранения истории для чата: ${chatId}`);

        if (!messages || !Array.isArray(messages)) {
            logError('История сообщений не указана или некорректна');
            return res.status(400).json({ error: 'История сообщений должна быть массивом' });
        }

        // Здесь можно добавить логику сохранения истории
        // Для теперь просто подтверждаем сохранение
        res.json({
            success: true,
            chatId: chatId,
            messagesCount: messages.length
        });
    } catch (error) {
        logError('Ошибка при сохранении истории чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения истории чата (для работы с Open WebUI)
router.get('/chats/:chatId/history', async (req, res) => {
    try {
        const { chatId } = req.params;

        logInfo(`Запрос истории для чата: ${chatId}`);

        // Здесь можно добавить логику получения истории из БД
        // Для теперь возвращаем пустую историю
        res.json({
            success: true,
            chatId: chatId,
            messages: []
        });
    } catch (error) {
        logError('Ошибка при получении истории чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// МЕДИА-ЭНДПОИНТЫ QWEN CHAT / DASHSCOPE
// ============================================

const CHAT_MEDIA_MODEL = 'qwen3-vl-plus';

function normalizeQwenAspectRatio(size, fallback = '16:9') {
    if (!size) return fallback;
    const value = String(size).trim();
    const ratioMap = {
        '1024x1024': '1:1',
        '512x512': '1:1',
        '768x768': '1:1',
        '960x960': '1:1',
        '1024x1792': '9:16',
        '1792x1024': '16:9',
        '1536x864': '16:9',
        '864x1536': '9:16'
    };
    if (ratioMap[value]) return ratioMap[value];
    if (/^\d+:\d+$/.test(value)) return value;
    return fallback;
}

function normalizeDashScopeSize(size) {
    const sizeMap = {
        '1024x1024': '1024*1024',
        '1024x1792': '1024*1792',
        '1792x1024': '1792*1024',
        '512x512': '512*512',
        '768x768': '768*768',
        '960x960': '960*960'
    };
    return sizeMap[size] || '1024*1024';
}

function buildOpenAiImageResponse({ imageUrl, prompt, model, raw, provider = 'qwen-chat' }) {
    return {
        created: Math.floor(Date.now() / 1000),
        watermark: FORGETMEAI_WATERMARK,
        provider,
        model,
        data: [{ url: imageUrl, revised_prompt: prompt }],
        raw
    };
}

function buildVideoResponse({ result, prompt, model, waitForCompletion }) {
    const videoUrl = result.video_url || extractMediaUrl(result, 'video');
    return {
        id: result.id || result.task_id || `video-${Date.now()}`,
        object: videoUrl ? 'video.generation' : 'video.generation.task',
        created: Math.floor(Date.now() / 1000),
        watermark: FORGETMEAI_WATERMARK,
        provider: 'qwen-chat',
        model,
        prompt,
        status: videoUrl ? 'completed' : (result.status || 'processing'),
        task_id: result.task_id || result.id || null,
        video_url: videoUrl || null,
        data: videoUrl ? [{ url: videoUrl }] : [],
        waitForCompletion,
        raw: result
    };
}

/**
 * POST /api/images/generations
 * По умолчанию генерирует изображения через Qwen Chat (`chatType: t2i`).
 * Для старого DashScope-режима передайте `provider: "dashscope"`.
 */
router.post('/images/generations', async (req, res) => {
    try {
        const signal = withClientAbortSignal(res);
        const { prompt, model, n, size, response_format, provider } = req.body;

        logInfo('Получен запрос на генерацию изображения');
        logDebug(`Запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
        }

        if (provider === 'dashscope') {
            const apiKey = process.env.DASHSCOPE_API_KEY;
            if (!apiKey) {
                return res.status(503).json({
                    error: 'DashScope API генерации изображений не настроен',
                    message: 'Установите переменную окружения DASHSCOPE_API_KEY или используйте provider=qwen-chat'
                });
            }

            let imageModel = model || 'qwen-image-plus';
            if (imageModel === 'dall-e-3' || imageModel === 'dall-e-2') imageModel = 'qwen-image-plus';
            const result = await generateImage(prompt, imageModel, {
                n: n || 1,
                size: normalizeDashScopeSize(size),
                promptExtend: true,
                watermark: false
            });

            if (result.error) {
                logError(`Ошибка генерации DashScope: ${result.error}`);
                return res.status(500).json({ error: 'Ошибка генерации изображения', message: result.error });
            }

            return res.json(buildOpenAiImageResponse({
                imageUrl: result.imageUrl,
                prompt,
                model: imageModel,
                raw: result,
                provider: 'dashscope'
            }));
        }

        const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
        const aspectRatio = normalizeQwenAspectRatio(size, req.body.aspect_ratio || '16:9');
        const result = await sendMessage(
            prompt,
            chatModel,
            null,
            null,
            null,
            null,
            null,
            null,
            't2i',
            aspectRatio,
            true,
            0,
            null,
            null,
            getSessionKey(req),
            signal
        );

        if (result.error) {
            logError(`Ошибка генерации Qwen Chat image: ${result.error}`);
            return res.status(500).json({ error: 'Ошибка генерации изображения через Qwen Chat', message: result.error, details: result.details });
        }

        const imageUrl = extractMediaUrl(result, 'image') || result.choices?.[0]?.message?.content || null;
        if (!imageUrl) {
            return res.status(502).json({
                error: 'Qwen Chat не вернул URL изображения',
                raw: result
            });
        }

        logInfo(`Изображение Qwen Chat сгенерировано: ${imageUrl}`);
        return res.json(buildOpenAiImageResponse({ imageUrl, prompt, model: chatModel, raw: result }));
    } catch (error) {
        logError('Ошибка при генерации изображения', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

/**
 * POST /api/videos/generations - Генерация видео через Qwen Chat (`chatType: t2v`).
 */
router.post('/videos/generations', async (req, res) => {
    try {
        const signal = withClientAbortSignal(res);
        const { prompt, model, size, wait, waitForCompletion } = req.body;
        const shouldWait = waitForCompletion ?? wait ?? true;

        logInfo('Получен запрос на генерацию видео через Qwen Chat');
        logDebug(`Видео-запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
        }

        const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
        const aspectRatio = normalizeQwenAspectRatio(size, req.body.aspect_ratio || '16:9');
        const result = await sendMessage(
            prompt,
            chatModel,
            null,
            null,
            null,
            null,
            null,
            null,
            't2v',
            aspectRatio,
            shouldWait,
            0,
            null,
            null,
            getSessionKey(req),
            signal
        );

        if (result.error) {
            logError(`Ошибка генерации Qwen Chat video: ${result.error}`);
            return res.status(500).json({ error: 'Ошибка генерации видео через Qwen Chat', message: result.error, details: result.details, task_id: result.task_id });
        }

        const response = buildVideoResponse({ result, prompt, model: chatModel, waitForCompletion: shouldWait });
        logInfo(response.video_url ? `Видео Qwen Chat сгенерировано: ${response.video_url}` : `Видео-задача создана: ${response.task_id}`);
        return res.json(response);
    } catch (error) {
        logError('Ошибка при генерации видео', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

/**
 * GET /api/tasks/status/:taskId - статус долгой задачи Qwen Chat (видео и будущие async-функции).
 */
router.get('/tasks/status/:taskId', async (req, res) => {
    try {
        const signal = withClientAbortSignal(res);
        const { taskId } = req.params;
        const wait = ['1', 'true', 'yes'].includes(String(req.query.wait || '').toLowerCase());
        if (!taskId) return res.status(400).json({ error: 'taskId обязателен' });

        const result = await pollQwenTaskStatus(taskId, wait, getSessionKey(req), signal);
        if (result.error && !result.data) {
            return sendApiResultError(res, result);
        }
        return res.json({ watermark: FORGETMEAI_WATERMARK, ...result });
    } catch (error) {
        logError('Ошибка при проверке статуса задачи', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

/**
 * GET /api/images/models - модели для генерации изображений.
 */
router.get('/images/models', async (req, res) => {
    try {
        const dashScopeModels = getAvailableImageModels();
        res.json({
            object: 'list',
            watermark: FORGETMEAI_WATERMARK,
            data: [
                {
                    id: CHAT_MEDIA_MODEL,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen-chat',
                    permission: [],
                    capability: 'qwen_chat_image_generation',
                    provider: 'qwen-chat'
                },
                ...dashScopeModels.map(model => ({
                    id: model,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen',
                    permission: [],
                    capability: 'image_generation',
                    provider: 'dashscope'
                }))
            ]
        });
    } catch (error) {
        logError('Ошибка при получении списка моделей изображений', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

/**
 * GET /api/videos/models - модели для генерации видео через Qwen Chat.
 */
router.get('/videos/models', async (req, res) => {
    res.json({
        object: 'list',
        watermark: FORGETMEAI_WATERMARK,
        data: [{
            id: CHAT_MEDIA_MODEL,
            object: 'model',
            created: Date.now(),
            owned_by: 'qwen-chat',
            permission: [],
            capability: 'qwen_chat_video_generation',
            provider: 'qwen-chat'
        }]
    });
});

/**
 * GET /api/images/status - Проверка статуса генерации изображений.
 */
router.get('/images/status', async (req, res) => {
    try {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        const dashScopeAvailable = await checkImageApiAvailability();
        const tokens = listTokens();
        const now = Date.now();
        const qwenChatAvailable = tokens.some(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);

        res.json({
            watermark: FORGETMEAI_WATERMARK,
            qwenChat: {
                available: qwenChatAvailable,
                model: CHAT_MEDIA_MODEL,
                message: qwenChatAvailable ? 'Qwen Chat генерация изображений доступна' : 'Нет активных аккаунтов Qwen Chat'
            },
            dashscope: {
                available: dashScopeAvailable,
                apiKeyConfigured: !!apiKey,
                message: dashScopeAvailable
                    ? 'DashScope API генерации изображений доступен'
                    : apiKey
                        ? 'DashScope API недоступен или неверные учётные данные'
                        : 'DASHSCOPE_API_KEY не настроен'
            }
        });
    } catch (error) {
        logError('Ошибка при проверке статуса API изображений', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

/**
 * GET /api/videos/status - Проверка готовности видео-генерации Qwen Chat.
 */
router.get('/videos/status', async (req, res) => {
    const tokens = listTokens();
    const now = Date.now();
    const availableAccounts = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid).length;
    res.json({
        watermark: FORGETMEAI_WATERMARK,
        available: availableAccounts > 0,
        model: CHAT_MEDIA_MODEL,
        accounts: { total: tokens.length, available: availableAccounts },
        message: availableAccounts > 0 ? 'Qwen Chat генерация видео доступна' : 'Нет активных аккаунтов Qwen Chat'
    });
});

export default router;
