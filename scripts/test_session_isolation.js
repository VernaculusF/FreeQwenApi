// Живой тест изоляции сессий (fork-логика на сервере).
// Opener ОДИНАКОВ для обеих сессий и НЕ содержит секрета — секрет вводится только
// в продолжении сессии A. Если сессии смешиваются, сессия B «вспомнит» секрет.
// Запуск: node scripts/test_session_isolation.js

const BASE = process.env.BASE || 'http://127.0.0.1:3264/api';
const KEY = process.env.KEY || '';
if (!KEY) { console.error('Set KEY=<api key> to run this live test.'); process.exit(2); }
const MODEL = 'qwen3.8-max';
const OPENER = 'Начинаем новую сессию. Ответь одной строкой, что готов.';
const CODED = 'НОЯБРЬ-3';

async function complete(messages) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, stream: true, messages })
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    let text = '';
    for await (const chunk of res.body) {
        const lines = new TextDecoder().decode(chunk).split('\n');
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) text += delta;
            } catch { /* ignore keepalive */ }
        }
    }
    return { text, ms: Date.now() - t0 };
}

const openerMessage = { role: 'user', content: OPENER };

async function main() {
    // --- Сессия A ---
    const a1 = await complete([openerMessage]);
    console.log(`A1 (${a1.ms}ms): ${a1.text.slice(0, 100)}`);

    const a2 = await complete([
        openerMessage,
        { role: 'assistant', content: a1.text },
        { role: 'user', content: `Запомни мой позывной: ${CODED}. Ответь одной строкой.` }
    ]);
    console.log(`A2 (${a2.ms}ms): ${a2.text.slice(0, 100)}`);

    const a3 = await complete([
        openerMessage,
        { role: 'assistant', content: a1.text },
        { role: 'user', content: `Запомни мой позывной: ${CODED}. Ответь одной строкой.` },
        { role: 'assistant', content: a2.text },
        { role: 'user', content: 'Какой у меня позывной? Ответь одной строкой.' }
    ]);
    console.log(`A3 (${a3.ms}ms): ${a3.text.slice(0, 100)}`);

    // --- Сессия B: тот же opener, но НОВАЯ беседа ---
    const b1 = await complete([openerMessage]);
    console.log(`B1 (${b1.ms}ms): ${b1.text.slice(0, 100)}`);

    const b2 = await complete([
        openerMessage,
        { role: 'assistant', content: b1.text },
        { role: 'user', content: 'Какой у меня позывной? Ответь одной строкой.' }
    ]);
    console.log(`B2 (${b2.ms}ms): ${b2.text.slice(0, 100)}`);

    const a3ok = new RegExp(CODED, 'i').test(a3.text);
    const b2ok = !new RegExp(CODED, 'i').test(b2.text);
    console.log('---');
    console.log(`A3 помнит позывной (континуация): ${a3ok ? 'OK' : 'FAIL'}`);
    console.log(`B2 НЕ помнит позывной (изоляция): ${b2ok ? 'OK' : 'FAIL'}`);
    process.exit(a3ok && b2ok ? 0 : 1);
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
