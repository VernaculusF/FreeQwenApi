// prod_load.js — ритмичная продакшн-нагрузка для FreeQwenApi.
//
// Цель: измерить реальную пропускную способность в продакшн-режиме —
// дефолтный проактивный лимитер (QWEN_OPS_PER_HOUR=25 паркует аккаунт при
// >=25 операций в часовом окне) + авто-солв x5sec + ротация.
//
// Дизайн:
//   - N сообщений на каждый аккаунт (--per-account, по умолчанию 100);
//   - стабильный клиентский chatId на аккаунт (`prod-load-1..14`): прокси сам
//     создаёт Qwen-чат при первом использовании и переиспользует дальше
//     (сообщение = 1 операция, без лишних create-chat);
//   - темп: --ops-per-hour (по умолчанию 24) операций/час на аккаунт — под
//     потолком лимитера, чтобы не провоцировать парковки;
//   - stream:true — продакшн-путь с Node fetch, на котором живёт авто-солв;
//   - цикл старт-к-старту фиксирован (интервал компенсирует латентность),
//     поэтому темп держится ровно даже когда авто-солв добавляет 8-10с.
//
// Использование:
//   node scripts/prod_load.js --port 3264 --model qwen3.8-max --per-account 100
//   node scripts/prod_load.js --resume        # продолжить с сохранённого раунда

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, '..', 'session', 'tokens.json');
const STATE_FILE = path.join(__dirname, '..', 'session', 'prod_load_state.json');

const args = process.argv.slice(2);
const get = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const PORT = Number(get('--port', process.env.PORT || 3264));
const MODEL = get('--model', 'qwen3.8-max');
const PER_ACCOUNT = Number(get('--per-account', 100));
const OPS_PER_HOUR = Number(get('--ops-per-hour', 24));
const REQUEST_TIMEOUT_MS = Number(get('--timeout-ms', 120_000));
const CHECKPOINT_EVERY = Number(get('--checkpoint-every', 50));
const RESUME = args.includes('--resume');
const BASE_URL = `http://127.0.0.1:${PORT}/api/v1/chat/completions`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const elapsed = (t0) => ((Date.now() - t0) / 1000).toFixed(0);

function poolSize() {
    try {
        const t = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        return t.filter(x => x && !x.invalid).length;
    } catch { return 0; }
}

// Распределение ops по аккаунтам из session/ops.json (ключи — хеши токенов).
function opsPerAccount() {
    try {
        const o = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'session', 'ops.json'), 'utf8'));
        const now = Date.now();
        return Object.entries(o).map(([k, v]) => ({ key: k, n: Array.isArray(v) ? v.filter(t => now - t < 3600_000).length : 0 })).sort((a, b) => b.n - a.n);
    } catch { return []; }
}

let completedRounds = 0;
const stats = { ok: 0, err: 0, r429: 0, ms: [] };
const chatIds = [];

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ completedRounds, model: MODEL }, null, 2));
}
function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        completedRounds = s.completedRounds || 0;
        return true;
    } catch { return false; }
}

async function oneRequest(chatId, label) {
    const t0 = Date.now();
    try {
        const res = await fetch(BASE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                chatId,
                messages: [{ role: 'user', content: `prod-load ping #${label}` }],
                stream: true
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const text = await res.text();
        return {
            ok: res.ok, status: res.status, ms: Date.now() - t0,
            err: res.ok ? null : text.slice(0, 200).replace(/\s+/g, ' ')
        };
    } catch (e) {
        return { ok: false, status: 0, ms: Date.now() - t0, err: e.message };
    }
}

function checkpoint(t0, round) {
    const done = stats.ok + stats.err + stats.r429;
    const secs = (Date.now() - t0) / 1000;
    const rate = done / (secs / 3600);
    const ms = stats.ms.slice().sort((a, b) => a - b);
    const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] || 0;
    const cycleSec = 3600 / (chatIds.length * OPS_PER_HOUR);
    const remaining = (PER_ACCOUNT - round) * chatIds.length * cycleSec;
    console.log(`[${nowIso()}] t+${elapsed(t0)}с раунд ${round}/${PER_ACCOUNT} | запросов: ${done} | OK=${stats.ok} 429=${stats.r429} ERR=${stats.err} | ${rate.toFixed(0)} req/ч | лат p50=${pct(0.5)}ms p95=${pct(0.95)}ms | ETA ~${(remaining / 60).toFixed(1)} мин`);
}

async function main() {
    const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.json()).catch(() => null);
    if (!health?.ok) { console.error('Сервер не отвечает или без аккаунтов:', JSON.stringify(health)); process.exit(1); }
    const pool = poolSize();
    console.log(`Сервер на :${PORT} OK (accounts=${health.accounts?.total}, available=${health.accounts?.available})`);
    console.log(`Режим: ${PER_ACCOUNT} сообщений/аккаунт × ${pool} аккаунтов = ${PER_ACCOUNT * pool} всего, темп ${OPS_PER_HOUR}/ч/акк (лимитер 25)`);

    for (let c = 1; c <= pool; c++) chatIds.push(`prod-load-${c}`);

    if (RESUME && loadState()) {
        console.log(`Resume: раундов сделано ${completedRounds}, продолжаем с ${completedRounds + 1}`);
    }

    const t0 = Date.now();
    const intervalMs = 3600_000 / (chatIds.length * OPS_PER_HOUR);
    console.log(`Интервал между стартами запросов: ${intervalMs.toFixed(0)}мс`);

    for (let round = completedRounds + 1; round <= PER_ACCOUNT; round++) {
        for (let c = 0; c < chatIds.length; c++) {
            const r = await oneRequest(chatIds[c], `r${round}c${c + 1}`);
            if (r.ok) { stats.ok++; } else if (r.status === 429) { stats.r429++; } else { stats.err++; }
            if (r.ok || r.status !== 429) stats.ms.push(r.ms);
            const tag = r.ok ? 'OK' : (r.status === 429 ? '429' : 'ERR');
            console.log(`[${nowIso()}] t+${elapsed(t0)}с r${round}/c${c + 1} ${tag} ${r.status} ${r.ms}ms${r.err ? ' ' + r.err.slice(0, 120) : ''}`);
            // цикл старт-к-старту = intervalMs: вычитаем латентность запроса,
            // чтобы темп держался ровно и при авто-солве (латентность 8-11с)
            await sleep(Math.max(300, intervalMs - r.ms));
        }
        completedRounds = round;
        if (round === 1) {
            const dist = opsPerAccount();
            console.log(`   [распределение ops после 1-го раунда] ${dist.map(d => `${d.n}`).join(', ')}`);
            const over = dist.filter(d => d.n > 2).length;
            if (over > 0) console.log(`   ⚠ ${over} аккаунтов получили >2 чата — распределение не ровное, лимитер подстрахует`);
        }
        if (round % CHECKPOINT_EVERY === 0 || round === PER_ACCOUNT) checkpoint(t0, round);
        saveState();
    }

    const secs = (Date.now() - t0) / 1000;
    const done = stats.ok + stats.err + stats.r429;
    const ms = stats.ms.slice().sort((a, b) => a - b);
    const avg = (stats.ms.reduce((a, b) => a + b, 0) / Math.max(stats.ms.length, 1)).toFixed(0);
    console.log('\n════════ ИТОГ ════════');
    console.log(`Всего: ${done} запросов за ${(secs / 60).toFixed(1)} мин`);
    console.log(`OK=${stats.ok} 429=${stats.r429} ERR=${stats.err}`);
    console.log(`Пропускная способность: ${(done / (secs / 3600)).toFixed(0)} запросов/час (${(done / (secs / 3600) / chatIds.length).toFixed(2)}/акк/час)`);
    console.log(`Латентность: avg=${avg}ms p50=${ms[Math.floor(ms.length * 0.5)]}ms p95=${ms[Math.floor(ms.length * 0.95)]}ms max=${ms[ms.length - 1]}ms`);
    process.exit(0);
}

main().catch(e => { console.error('PROD LOAD ERROR:', e); process.exit(1); });
