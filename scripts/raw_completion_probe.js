// raw_completion_probe.js — сырой (мимо прокси/браузера) запрос к Qwen:
// создаёт чат и отправляет completion, чтобы увидеть реальный ответ Qwen,
// когда completion «висит» через браузерный fetch.
//
// Использование:
//   node scripts/raw_completion_probe.js [--timeout-ms 30000]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, '..', 'session', 'tokens.json');

const TIMEOUT = Number(process.argv[3] || 30_000);
const BASE = 'https://chat.qwen.ai';
const CREATE_URL = `${BASE}/api/v2/chats/new`;
const COMPLETE_URL = `${BASE}/api/v2/chat/completions`;

const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')).filter(t => t && !t.invalid);
const token = tokens[0]?.token || tokens[0]?.auth_token;

function headers() {
    return {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Timezone': new Date().toString().replace(/[\u0080-\uFFFF]/g, ''),
        'Version': '0.2.63',
        'X-Request-Id': crypto.randomUUID(),
        'source': 'web',
        'Authorization': `Bearer ${token}`
    };
}

async function step(name, url, body) {
    const t0 = Date.now();
    try {
        const res = await fetch(url, {
            method: body ? 'POST' : 'GET',
            headers: headers(),
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(TIMEOUT)
        });
        const text = await res.text();
        console.log(`[${name}] HTTP ${res.status} ${Date.now() - t0}ms`);
        console.log(`  body: ${text.slice(0, 500).replace(/\s+/g, ' ')}`);
        return { status: res.status, text };
    } catch (e) {
        console.log(`[${name}] ERROR ${Date.now() - t0}ms: ${e.message?.slice(0, 120)}`);
        return { status: 0, text: '' };
    }
}

async function main() {
    console.log(`Аккаунт: ${tokens[0].id}`);
    const create = await step('create-chat', CREATE_URL, {
        title: 'raw-probe', models: ['qwen3.8-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now()
    });
    let chatId = null;
    try { chatId = JSON.parse(create.text)?.data?.id; } catch { /* no */ }
    if (!chatId) { console.log('Нет chatId — стоп'); process.exit(1); }
    console.log(`chatId: ${chatId}`);

    const parentId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();
    const payload = {
        stream: true,
        version: '2.1',
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        messages: [{
            fid: userMessageId, parentId, parent_id: parentId,
            role: 'user', content: 'raw probe',
            chat_type: 't2t', sub_chat_type: 't2t',
            timestamp: Math.floor(Date.now() / 1000),
            user_action: 'chat', models: ['qwen3.8-max'], files: [],
            childrenIds: [assistantChildId],
            extra: { meta: { subChatType: 't2t' } },
            feature_config: { thinking_enabled: false, output_schema: 'phase' }
        }],
        model: 'qwen3.8-max',
        parent_id: parentId,
        timestamp: Math.floor(Date.now() / 1000)
    };
    await step('completion', `${COMPLETE_URL}?chat_id=${chatId}`, payload);
    process.exit(0);
}

main().catch(e => { console.error('PROBE ERROR:', e.message); process.exit(1); });
