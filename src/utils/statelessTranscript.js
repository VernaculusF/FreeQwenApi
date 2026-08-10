// Capped stateless transcript builder for OpenAI-compatible clients.
//
// Stateless clients (opencode, Hermes, Codex...) resend their full conversation
// history on every request. Folding it into one user message with no size cap
// produced multi-megabyte payloads that Qwen Chat rejects or stalls on (WAF
// challenge, browser-fetch protocolTimeout). The transcript is now a tail window:
// the most recent turns are kept in order, and the total size is capped so a
// long session still reaches the model without blowing up the request.

function resolveFoldMaxChars() {
    const v = Number.parseInt(process.env.QWEN_FOLD_MAX_CHARS || '', 10);
    return Number.isFinite(v) && v > 0 ? v : 120_000;
}

export const FOLD_MAX_CHARS = resolveFoldMaxChars();

export function stringifyOpenAIContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(item => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (item.type === 'text') return item.text || '';
            if (item.type === 'image_url') return `[image: ${item.image_url?.url || ''}]`;
            if (item.type === 'image') return `[image: ${item.image || ''}]`;
            if (item.type === 'file') return `[file: ${item.file || item.name || ''}]`;
            return JSON.stringify(item);
        }).filter(Boolean).join('\n');
    }
    return JSON.stringify(content);
}

/**
 * Fold an OpenAI-format message list into a single user-facing transcript.
 * System messages are skipped. Order is preserved. The transcript is a tail
 * window capped at `maxChars` characters (QWEN_FOLD_MAX_CHARS by default):
 * a single over-long message is truncated to the cap, and earlier messages are
 * omitted with a marker once the window is full.
 */
export function buildStatelessTranscript(messages, maxChars = FOLD_MAX_CHARS) {
    const items = [];
    for (const msg of messages || []) {
        if (!msg || msg.role === 'system') continue;
        let line = '';
        if (msg.role === 'user') {
            line = `User: ${stringifyOpenAIContent(msg.content)}`;
        } else if (msg.role === 'assistant') {
            const text = stringifyOpenAIContent(msg.content);
            const chunks = [];
            if (text) chunks.push(`Assistant: ${text}`);
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                chunks.push(`Assistant tool calls: ${JSON.stringify(msg.tool_calls)}`);
            }
            line = chunks.join('\n');
        } else if (msg.role === 'tool') {
            const name = msg.name || msg.tool_call_id || 'tool';
            line = `Tool result (${name}): ${stringifyOpenAIContent(msg.content)}`;
        } else {
            line = `${msg.role || 'message'}: ${stringifyOpenAIContent(msg.content)}`;
        }
        if (line) items.push(line);
    }

    const out = [];
    let total = 0;
    for (let i = items.length - 1; i >= 0; i--) {
        const line = items[i].length > maxChars ? items[i].slice(0, maxChars) : items[i];
        if (total + line.length > maxChars && out.length > 0) break;
        out.unshift(line);
        total += line.length;
    }
    const omitted = items.length - out.length;
    const marker = omitted > 0
        ? `[FreeQwenApi: ${omitted} earlier message(s) omitted; transcript capped at ${maxChars} chars (QWEN_FOLD_MAX_CHARS)]`
        : '';
    return [marker, ...out].filter(Boolean).join('\n\n');
}
