import crypto from 'crypto';
import fs from 'fs';
import http from 'http';

const DEFAULT_AFFINITY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AFFINITIES = 4096;
const MAX_ID_LENGTH = 2048;

function normalizeIdentifier(value) {
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_ID_LENGTH) return null;
    const lower = normalized.toLowerCase();
    return lower === 'null' || lower === 'undefined' ? null : normalized;
}

function requestHeader(req, name) {
    const value = req?.headers?.[name.toLowerCase()] ?? req?.get?.(name);
    return Array.isArray(value) ? value[0] : value;
}

function parseStructuredValue(value) {
    if (value && typeof value === 'object') return value;
    const normalized = normalizeIdentifier(value);
    if (!normalized) return null;

    const candidates = [normalized];
    try {
        const decoded = decodeURIComponent(normalized);
        if (decoded !== normalized) candidates.push(decoded);
    } catch {
        // Not URL encoded.
    }
    if (/^[A-Za-z0-9_-]+={0,2}$/.test(normalized) && normalized.length >= 8) {
        try {
            const decoded = Buffer.from(normalized, 'base64url').toString('utf8');
            if (decoded) candidates.push(decoded);
        } catch {
            // Not base64url encoded.
        }
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch {
            // Try the next representation.
        }
    }
    return null;
}

function findStructuredId(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 3) return null;
    const idKeys = [
        'conversation_id', 'conversationId', 'thread_id', 'threadId',
        'session_id', 'sessionId', 'chat_id', 'chatId'
    ];
    for (const key of idKeys) {
        const normalized = normalizeIdentifier(value[key]);
        if (normalized) return normalized;
    }
    for (const key of ['conversation', 'thread', 'session', 'metadata', 'context']) {
        const nested = findStructuredId(value[key], depth + 1);
        if (nested) return nested;
    }
    return null;
}

function firstIdentifier(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeIdentifier(candidate.value);
        if (normalized) return { value: normalized, source: candidate.source };
    }
    return null;
}

function inputConversationHint(input) {
    if (!Array.isArray(input)) return null;
    for (const item of input) {
        const metadata = item?.internal_chat_message_metadata_passthrough ?? item?.metadata;
        const structuredId = findStructuredId(metadata);
        if (structuredId) return { value: structuredId, source: 'input_metadata' };
    }
    for (const item of input) {
        const metadata = item?.internal_chat_message_metadata_passthrough ?? item?.metadata;
        const turnId = normalizeIdentifier(metadata?.turn_id ?? metadata?.turnId);
        if (turnId) return { value: turnId, source: 'root_turn_id' };
    }
    return null;
}

function opaqueConversationId(value) {
    const digest = crypto.createHash('sha256').update(value).digest('hex');
    return `codex_${digest.slice(0, 40)}`;
}

export function extractConversationIdentity(body = {}, req = {}) {
    const metadata = parseStructuredValue(body.metadata) || {};
    const clientMetadata = parseStructuredValue(body.client_metadata) || {};
    const conversation = parseStructuredValue(body.conversation) || {};
    const turnMetadata = parseStructuredValue(requestHeader(req, 'x-codex-turn-metadata')) || {};
    const explicit = firstIdentifier([
        { value: body.conversation_id, source: 'body.conversation_id' },
        { value: body.conversationId, source: 'body.conversationId' },
        { value: typeof body.conversation === 'string' ? body.conversation : null, source: 'body.conversation' },
        { value: findStructuredId(conversation), source: 'body.conversation' },
        { value: findStructuredId(metadata), source: 'body.metadata' },
        { value: findStructuredId(clientMetadata), source: 'body.client_metadata' },
        { value: requestHeader(req, 'x-codex-thread-id'), source: 'header.x-codex-thread-id' },
        { value: requestHeader(req, 'x-codex-conversation-id'), source: 'header.x-codex-conversation-id' },
        { value: requestHeader(req, 'x-conversation-id'), source: 'header.x-conversation-id' },
        { value: requestHeader(req, 'x-thread-id'), source: 'header.x-thread-id' },
        { value: findStructuredId(turnMetadata), source: 'header.x-codex-turn-metadata' }
    ]) || inputConversationHint(body.input) || firstIdentifier([
        { value: turnMetadata.turn_id, source: 'header.x-codex-turn-metadata.turn_id' },
        { value: turnMetadata.turnId, source: 'header.x-codex-turn-metadata.turnId' },
        { value: body.prompt_cache_key, source: 'body.prompt_cache_key' },
        { value: body.promptCacheKey, source: 'body.promptCacheKey' }
    ]);
    const previousResponseId = firstIdentifier([
        { value: body.previous_response_id, source: 'body.previous_response_id' },
        { value: body.previousResponseId, source: 'body.previousResponseId' },
        { value: requestHeader(req, 'x-previous-response-id'), source: 'header.x-previous-response-id' }
    ])?.value || null;

    return {
        explicitId: explicit?.value || null,
        source: explicit?.source || (previousResponseId ? 'previous_response_id' : 'generated'),
        previousResponseId
    };
}

function upstreamIndexForKey(key, upstreamCount) {
    const digest = crypto.createHash('sha256').update(key).digest();
    return digest.readUInt32BE(0) % upstreamCount;
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createConversationAffinity(options = {}) {
    const upstreamCount = Number(options.upstreamCount || 1);
    if (!Number.isInteger(upstreamCount) || upstreamCount < 1) {
        throw new Error('upstreamCount must be a positive integer');
    }
    const ttlMs = positiveNumber(options.ttlMs, DEFAULT_AFFINITY_TTL_MS);
    const maxEntries = Math.floor(positiveNumber(options.maxEntries, DEFAULT_MAX_AFFINITIES));
    const maxResponseIds = Math.max(
        maxEntries,
        Math.floor(positiveNumber(options.maxResponseIds, maxEntries * 16))
    );
    const now = options.now || (() => Date.now());
    const aliases = new Map();
    const records = new Map();
    const responseIds = new Map();

    function removeCanonical(canonical) {
        records.delete(canonical);
        for (const [alias, target] of aliases) {
            if (target === canonical) aliases.delete(alias);
        }
        for (const [responseId, record] of responseIds) {
            if (record.canonical === canonical) responseIds.delete(responseId);
        }
    }

    function prune(timestamp = now()) {
        for (const [responseId, record] of responseIds) {
            if (timestamp - record.lastTouched > ttlMs) responseIds.delete(responseId);
        }
        for (const [canonical, record] of records) {
            if (timestamp - record.lastTouched > ttlMs) removeCanonical(canonical);
        }
        while (records.size > maxEntries) {
            const oldest = records.keys().next().value;
            if (!oldest) break;
            removeCanonical(oldest);
        }
    }

    function resolve(identity = {}) {
        const timestamp = now();
        prune(timestamp);
        const explicitKey = identity.explicitId
            ? opaqueConversationId(identity.explicitId)
            : null;
        const previous = identity.previousResponseId
            ? responseIds.get(identity.previousResponseId)
            : null;
        let canonical = previous?.canonical
            || (explicitKey ? aliases.get(explicitKey) || explicitKey : null)
            || (identity.previousResponseId ? opaqueConversationId(identity.previousResponseId) : null)
            || `codex_${crypto.randomUUID().replaceAll('-', '')}`;

        if (previous && explicitKey && explicitKey !== canonical) aliases.set(explicitKey, canonical);
        if (!records.has(canonical)) {
            if (records.size >= maxEntries) {
                const oldest = records.keys().next().value;
                if (oldest) removeCanonical(oldest);
            }
            records.set(canonical, {
                upstreamIndex: upstreamIndexForKey(canonical, upstreamCount),
                lastTouched: timestamp
            });
        } else {
            const record = records.get(canonical);
            record.lastTouched = timestamp;
            records.delete(canonical);
            records.set(canonical, record);
        }
        if (explicitKey) aliases.set(explicitKey, canonical);
        return { conversationId: canonical, ...records.get(canonical) };
    }

    function bindResponse(responseId, conversationId) {
        const normalized = normalizeIdentifier(responseId);
        if (!normalized || !records.has(conversationId)) return false;
        responseIds.set(normalized, { canonical: conversationId, lastTouched: now() });
        while (responseIds.size > maxResponseIds) {
            responseIds.delete(responseIds.keys().next().value);
        }
        return true;
    }

    function setUpstream(conversationId, upstreamIndex) {
        const record = records.get(conversationId);
        if (!record || !Number.isInteger(upstreamIndex) || upstreamIndex < 0 || upstreamIndex >= upstreamCount) {
            return false;
        }
        record.upstreamIndex = upstreamIndex;
        record.lastTouched = now();
        return true;
    }

    function stats() {
        return { conversations: records.size, response_ids: responseIds.size, aliases: aliases.size };
    }

    return { bindResponse, resolve, setUpstream, stats };
}

function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(part => ['input_text', 'output_text', 'text'].includes(part?.type))
        .map(part => String(part.text || ''))
        .join('\n');
}

function messageContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const part of content) {
        if (['input_text', 'output_text', 'text'].includes(part?.type)) {
            parts.push({ type: 'text', text: String(part.text || '') });
        } else if (part?.type === 'input_image' && (part.image_url || part.url)) {
            parts.push({ type: 'image_url', image_url: { url: part.image_url || part.url } });
        }
    }
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
    return parts;
}

export function responsesToChat(body, options = {}) {
    const requestedModel = String(body.model || '');
    const model = /^(qwen|qwq|qvq)/i.test(requestedModel) ? requestedModel : 'qwen3.8-max';
    const messages = [];
    if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
    const input = typeof body.input === 'string'
        ? [{ type: 'message', role: 'user', content: body.input }]
        : (Array.isArray(body.input) ? body.input : []);

    for (const item of input) {
        if (item?.type === 'message') {
            const role = item.role === 'developer' ? 'system' : (item.role || 'user');
            messages.push({ role, content: messageContent(item.content) });
        } else if (item?.type === 'function_call') {
            messages.push({
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: item.call_id || item.id,
                    type: 'function',
                    function: { name: item.name, arguments: item.arguments || '{}' }
                }]
            });
        } else if (item?.type === 'function_call_output') {
            messages.push({
                role: 'tool',
                tool_call_id: item.call_id,
                content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
            });
        }
    }

    const tools = (body.tools || [])
        .filter(tool => tool?.type === 'function' && tool.name)
        .map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.parameters || { type: 'object', properties: {} },
                ...(tool.strict === undefined ? {} : { strict: tool.strict })
            }
        }));

    return {
        model,
        messages,
        stream: true,
        ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
        ...(tools.length ? { tools, tool_choice: body.tool_choice || 'auto' } : {})
    };
}

function writeEvent(res, state, type, payload) {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: state.sequence++, ...payload })}\n\n`);
}

function responseShell(id, model, status = 'in_progress', output = [], usage = undefined) {
    return {
        id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status,
        model,
        output,
        ...(usage ? { usage } : {})
    };
}

function normalizeUsage(usage = {}) {
    const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
    const output = Number(usage.completion_tokens || usage.output_tokens || 0);
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: Number(usage.total_tokens || input + output),
        input_tokens_details: { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens || 0) },
        output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0) }
    };
}

function createTextOutput(res, state, outputs) {
    const outputIndex = outputs.length;
    const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const record = { kind: 'text', id, outputIndex, text: '' };
    outputs.push(record);
    const item = { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    writeEvent(res, state, 'response.output_item.added', { output_index: outputIndex, item });
    writeEvent(res, state, 'response.content_part.added', {
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
    });
    return record;
}

function createToolOutput(res, state, outputs, delta, index) {
    const outputIndex = outputs.length;
    const callId = delta.id || `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const id = `fc_${crypto.randomUUID().replaceAll('-', '')}`;
    const record = {
        kind: 'tool', id, callId, outputIndex, sourceIndex: index,
        name: delta.function?.name || '', arguments: ''
    };
    outputs.push(record);
    writeEvent(res, state, 'response.output_item.added', {
        output_index: outputIndex,
        item: { id, type: 'function_call', status: 'in_progress', arguments: '', call_id: callId, name: record.name }
    });
    return record;
}

function finishOutputs(res, state, outputs) {
    return outputs.map(record => {
        if (record.kind === 'text') {
            const part = { type: 'output_text', text: record.text, annotations: [] };
            writeEvent(res, state, 'response.output_text.done', {
                item_id: record.id, output_index: record.outputIndex, content_index: 0, text: record.text
            });
            writeEvent(res, state, 'response.content_part.done', {
                item_id: record.id, output_index: record.outputIndex, content_index: 0, part
            });
            const item = { id: record.id, type: 'message', role: 'assistant', status: 'completed', content: [part] };
            writeEvent(res, state, 'response.output_item.done', { output_index: record.outputIndex, item });
            return item;
        }
        writeEvent(res, state, 'response.function_call_arguments.done', {
            item_id: record.id, output_index: record.outputIndex, arguments: record.arguments
        });
        const item = {
            id: record.id, type: 'function_call', status: 'completed', arguments: record.arguments,
            call_id: record.callId, name: record.name
        };
        writeEvent(res, state, 'response.output_item.done', { output_index: record.outputIndex, item });
        return item;
    });
}

async function streamUpstream(upstream, res, responseId, model) {
    if (!upstream.ok) {
        const body = await upstream.text();
        throw new Error(`Qwen upstream ${upstream.status}: ${body.slice(0, 1000)}`);
    }
    if (!upstream.body) throw new Error('Qwen upstream returned no response body');

    const state = { sequence: 0 };
    const outputs = [];
    const tools = new Map();
    let textOutput = null;
    let usage = {};
    writeEvent(res, state, 'response.created', { response: responseShell(responseId, model) });

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, boundary).trimEnd();
            buffer = buffer.slice(boundary + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let data;
            try { data = JSON.parse(raw); } catch { continue; }
            if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
            if (data.usage) usage = data.usage;
            const delta = data.choices?.[0]?.delta || {};
            if (typeof delta.content === 'string' && delta.content) {
                if (!textOutput) textOutput = createTextOutput(res, state, outputs);
                textOutput.text += delta.content;
                writeEvent(res, state, 'response.output_text.delta', {
                    item_id: textOutput.id,
                    output_index: textOutput.outputIndex,
                    content_index: 0,
                    delta: delta.content
                });
            }
            for (const callDelta of delta.tool_calls || []) {
                const sourceIndex = Number.isInteger(callDelta.index) ? callDelta.index : 0;
                let record = tools.get(sourceIndex);
                const isNew = !record;
                if (!record) {
                    record = createToolOutput(res, state, outputs, callDelta, sourceIndex);
                    tools.set(sourceIndex, record);
                }
                if (callDelta.id) record.callId = callDelta.id;
                if (!isNew && callDelta.function?.name) {
                    record.name += callDelta.function.name;
                }
                const argumentDelta = callDelta.function?.arguments || '';
                if (argumentDelta) {
                    record.arguments += argumentDelta;
                    writeEvent(res, state, 'response.function_call_arguments.delta', {
                        item_id: record.id,
                        output_index: record.outputIndex,
                        delta: argumentDelta
                    });
                }
            }
        }
    }
    const finalOutput = finishOutputs(res, state, outputs);
    writeEvent(res, state, 'response.completed', {
        response: responseShell(responseId, model, 'completed', finalOutput, normalizeUsage(usage))
    });
}

async function readJson(req, limit = 10 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('Request body is too large');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readSecret(filePath) {
    return filePath ? fs.readFileSync(filePath, 'utf8').trim() : '';
}

function retryableUpstreamStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function openUpstream(upstreams, preferredIndex, init) {
    let lastError = null;
    for (let offset = 0; offset < upstreams.length; offset++) {
        const upstreamIndex = (preferredIndex + offset) % upstreams.length;
        const upstreamUrl = upstreams[upstreamIndex];
        try {
            const response = await fetch(upstreamUrl, init);
            if (response.ok) return { response, upstreamIndex };
            const body = await response.text();
            lastError = new Error(`Qwen upstream ${response.status}: ${body.slice(0, 1000)}`);
            if (!retryableUpstreamStatus(response.status)) break;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('No Qwen upstream is available');
}

export function createResponsesBridge(options = {}) {
    const upstreams = options.upstreams || ['http://127.0.0.1:3264/api/v1/chat/completions'];
    if (!Array.isArray(upstreams) || upstreams.length === 0) throw new Error('At least one upstream is required');
    const upstreamKey = options.upstreamKey || '';
    const bridgeKey = options.bridgeKey || '';
    const logIdentities = options.logIdentities === true;
    const affinity = options.affinity || createConversationAffinity({
        upstreamCount: upstreams.length,
        ttlMs: options.affinityTtlMs,
        maxEntries: options.maxAffinities
    });

    return http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                service: 'FreeQwen Responses Bridge',
                version: 2,
                routing: 'conversation-sticky',
                upstreams: upstreams.length,
                affinity: affinity.stats()
            }));
            return;
        }
        if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(req.url)) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
            return;
        }
        if (bridgeKey && req.headers.authorization !== `Bearer ${bridgeKey}`) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'authentication_error' } }));
            return;
        }

        try {
            const body = await readJson(req);
            const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
            const identity = extractConversationIdentity(body, req);
            const route = affinity.resolve(identity);
            affinity.bindResponse(responseId, route.conversationId);
            const upstreamBody = JSON.stringify(responsesToChat(body, {
                conversationId: route.conversationId
            }));
            const { response: upstream, upstreamIndex } = await openUpstream(upstreams, route.upstreamIndex, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'user-agent': 'freeqwen-responses-bridge/2',
                    'x-conversation-id': route.conversationId,
                    ...(upstreamKey ? { authorization: `Bearer ${upstreamKey}` } : {})
                },
                body: upstreamBody
            });
            if (upstreamIndex !== route.upstreamIndex) {
                affinity.setUpstream(route.conversationId, upstreamIndex);
            }
            if (logIdentities) {
                console.log(JSON.stringify({
                    event: 'conversation_route',
                    source: identity.source,
                    previous_response: Boolean(identity.previousResponseId),
                    conversation: route.conversationId.slice(-12),
                    upstream: upstreamIndex,
                    body_keys: Object.keys(body).sort()
                }));
            }
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive'
            });
            await streamUpstream(upstream, res, responseId, body.model);
            res.end();
        } catch (error) {
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
            if (!res.writableEnded) {
                res.end(JSON.stringify({ error: { message: error.message, type: 'upstream_error' } }));
            }
        }
    });
}

export function startResponsesBridgeFromEnv() {
    const port = Number(process.env.PORT || 3270);
    const host = process.env.HOST || '127.0.0.1';
    const upstreams = (process.env.QWEN_UPSTREAMS || 'http://127.0.0.1:3264/api/v1/chat/completions,http://127.0.0.1:3265/api/v1/chat/completions')
        .split(',').map(value => value.trim()).filter(Boolean);
    const server = createResponsesBridge({
        upstreams,
        upstreamKey: readSecret(process.env.QWEN_API_KEY_FILE),
        bridgeKey: readSecret(process.env.BRIDGE_API_KEY_FILE),
        logIdentities: process.env.BRIDGE_LOG_IDENTITIES === '1',
        affinityTtlMs: Number(process.env.BRIDGE_AFFINITY_TTL_MS || DEFAULT_AFFINITY_TTL_MS),
        maxAffinities: Number(process.env.BRIDGE_MAX_AFFINITIES || DEFAULT_MAX_AFFINITIES)
    });
    server.listen(port, host, () => {
        console.log(`FreeQwen Responses Bridge listening on http://${host}:${port}`);
    });
    return server;
}
