// stress_test.js — стресс-тест прокси FreeQwenApi.
//
// Цель: измерить, как быстро аккаунты Qwen начинают блокаться (429/RateLimited)
// под нагрузкой и как быстро разблокаются (resetAt → повторная проверка → OK).
//
// Фаза 1: последовательная очередь запросов (concurrency=1).
// Фаза 2: если блоков не было — параллельная очередь (по умолчанию 3, не больше
//         PAGE_POOL_SIZE браузера).
//
// Каждые `--snapshot-every` запросов читаем session/tokens.json (тот же файл,
// что пишет сервер) и печатаем таймлайн: сколько аккаунтов OK/WAIT, у каких
// resetAt. 429-е печатаются с телом ошибки (там поле `num` — часы блокировки,
// которые Qwen назначил сам).
//
// После фазы 2 — мониторинг восстановления: ждём, пока чей-то resetAt истечёт,
// и подтверждаем рабочим запросом. Ограничен окном `--recovery-window-s`.
//
// Использование:
//   node scripts/stress_test.js --port 3264 --model qwen3.8-max \
//       --phase1-budget 30 --phase2-budget 30 --concurrency 3
//
//   Режим "N на аккаунт": --per-account 100 (общий бюджет = N × размер пула;
//   пул берётся из session/tokens.json, можно переопределить --pool-size).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, '..', 'session', 'tokens.json');

// ─── Аргументы ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const PORT = Number(get('--port', process.env.PORT || 3264));
const MODEL = get('--model', 'qwen3.8-max');
const PHASE1_BUDGET = Number(get('--phase1-budget', 30));
const PHASE2_BUDGET = Number(get('--phase2-budget', 30));
const CONCURRENCY = Number(get('--concurrency', 3));
const SNAPSHOT_EVERY = Number(get('--snapshot-every', 10));
const DELAY_MS = Number(get('--delay-ms', 0));
const RECOVERY_WINDOW_S = Number(get('--recovery-window-s', 900));
const REQUEST_TIMEOUT_MS = Number(get('--timeout-ms', 90_000));
const PER_ACCOUNT = Number(get('--per-account', 0));
const POOL_SIZE = Number(get('--pool-size', 0)); // 0 = вычислить из tokens.json
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

// ─── Утилиты ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const elapsed = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

function readTokens() {
    try {
        return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    } catch { return null; }
}

function accountSnapshot() {
    const tokens = readTokens();
    if (!tokens) return null;
    const now = Date.now();
    const ok = [], wait = [];
    for (const t of tokens) {
        if (t.invalid) continue;
        if (t.resetAt && new Date(t.resetAt).getTime() > now) wait.push({ id: t.id, resetAt: t.resetAt });
        else ok.push(t.id);
    }
    return { ok: ok.length, wait, total: ok.length + wait.length };
}

// Один chat completion через прокси. Возвращает { ok, status, ms, body, error }.
async function oneRequest(i) {
    const t0 = Date.now();
    try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                messages: [{ role: 'user', content: `stress ping #${i}` }],
                stream: false
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const text = await res.text();
        const body = text.slice(0, 600);
        return { ok: res.ok, status: res.status, ms: Date.now() - t0, body, error: null };
    } catch (e) {
        return { ok: false, status: 0, ms: Date.now() - t0, body: '', error: e.message };
    }
}

async function burst(label, budget, concurrency, state) {
    let next = state.next;
    const results = [];
    const queue = async (workerId) => {
        while (true) {
            const i = next++;
            if (i > budget) return;
            const r = await oneRequest(i);
            results.push(r);
            state.total200 += r.ok && r.status === 200 ? 1 : 0;
            state.total429 += r.status === 429 ? 1 : 0;
            state.totalErr += (!r.ok && r.status !== 429) ? 1 : 0;
            state.requests.push({ i, ...r });
            const bucket = [];
            bucket.push(`[${nowIso()}] t+${elapsed(state.t0)}s #${i} ${r.ok ? 'OK' : 'FAIL'} ${r.status} ${r.ms}ms`);
            if (r.status === 429) bucket.push(`   429 body: ${r.body.replace(/\s+/g, ' ').slice(0, 200)}`);
            if (r.error) bucket.push(`   error: ${r.error}`);
            process.stdout.write(bucket.join('\n') + '\n');

            if (i % SNAPSHOT_EVERY === 0 || r.status === 429) {
                const snap = accountSnapshot();
                if (snap) {
                    const waitInfo = snap.wait.map(w => `${w.id.slice(-6)}@${w.resetAt.slice(11, 16)}`).join(', ');
                    process.stdout.write(`   [snap] OK=${snap.ok}/${snap.total} WAIT=${snap.wait.length}${waitInfo ? ' (' + waitInfo + ')' : ''}\n`);
                }
            }
            if (DELAY_MS > 0) await sleep(DELAY_MS);
        }
    };
    const workers = Array.from({ length: concurrency }, (_, w) => queue(w));
    await Promise.all(workers);
    // Пишем обратно, чтобы следующая фаза продолжала нумерацию, а не
    // перезапускала с #1 (иначе индексы в логе дублируются и нагрузка
    // задваивается в статистике).
    state.next = next;
    return results;
}

function printSummary(state) {
    const reqs = state.requests;
    const statuses = {};
    for (const r of reqs) statuses[r.status] = (statuses[r.status] || 0) + 1;
    console.log('\n════════ СВОДКА ════════');
    console.log(`Всего запросов: ${reqs.length} за ${elapsed(state.t0)}с`);
    console.log(`По статусам: ${Object.entries(statuses).map(([s, n]) => `${s}:${n}`).join(', ')}`);
    if (reqs.length) {
        const ms = reqs.map(r => r.ms).sort((a, b) => a - b);
        const avg = (ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(0);
        console.log(`Латентность: avg=${avg}ms p50=${ms[Math.floor(ms.length * 0.5)]}ms p95=${ms[Math.floor(ms.length * 0.95)]}ms max=${ms[ms.length - 1]}ms`);
    }
    const snap = accountSnapshot();
    if (snap) {
        console.log(`Аккаунты сейчас: OK=${snap.ok}/${snap.total}, WAIT=${snap.wait.length}`);
        for (const w of snap.wait) console.log(`   WAIT ${w.id} → resetAt ${w.resetAt} (через ${((new Date(w.resetAt) - Date.now()) / 60000).toFixed(1)} мин)`);
    }
}

async function monitorRecovery(state, windowS) {
    const deadline = Date.now() + windowS * 1000;
    console.log(`\n════════ МОНИТОРИНГ ВОССТАНОВЛЕНИЯ (окно ${windowS}с) ════════`);
    let lastOk = null;
    while (Date.now() < deadline) {
        const snap = accountSnapshot();
        const waiting = snap ? snap.wait : [];
        if (waiting.length === 0 && lastOk !== null) {
            console.log(`[${nowIso()}] все аккаунты снова OK — восстановление завершено`);
            break;
        }
        if (waiting.length === 0) {
            console.log(`[${nowIso()}] блоков нет — нечего восстанавливать`);
            break;
        }
        // Есть ли аккаунт, чей resetAt уже истёк?
        const expired = waiting.filter(w => new Date(w.resetAt).getTime() <= Date.now() + 2000);
        if (expired.length > 0) {
            const id = expired[0].id;
            console.log(`[${nowIso()}] resetAt истёк у ${id} — проверяем рабочим запросом...`);
            const r = await oneRequest('recovery-probe');
            if (r.ok && r.status === 200) {
                console.log(`[${nowIso()}] ✓ рабочий запрос прошёл (${r.ms}ms) — аккаунт снова в пуле`);
                lastOk = true;
            } else {
                console.log(`[${nowIso()}] ✗ рабочий запрос: ${r.status} ${r.body.slice(0, 120)}`);
                lastOk = false;
            }
        }
        await sleep(5000);
    }
    const snap = accountSnapshot();
    if (snap) {
        console.log('Финальное состояние аккаунтов:');
        for (const w of snap.wait) console.log(`   WAIT ${w.id} → ${w.resetAt} (ещё ${((new Date(w.resetAt) - Date.now()) / 60000).toFixed(1)} мин)`);
    }
}

// ─── Запуск ──────────────────────────────────────────────────────────────────
async function main() {
    // Пинг сервера
    try {
        const h = await fetch(`${BASE_URL}/health`);
        const j = await h.json();
        console.log(`Сервер на :${PORT} отвечает (ok=${j.ok}, models=${j.models})`);
    } catch {
        console.error(`Сервер не отвечает на ${BASE_URL}/health. Запустите: NON_INTERACTIVE=1 SKIP_ACCOUNT_MENU=1 PORT=${PORT} node index.js`);
        process.exit(1);
    }

    const state = {
        t0: Date.now(), requests: [], next: 1,
        total200: 0, total429: 0, totalErr: 0
    };

    const before = accountSnapshot();
    console.log(`Аккаунтов до: OK=${before?.ok}/${before?.total}, WAIT=${before?.wait.length}`);

    let phase1Budget = PHASE1_BUDGET;
    let phase2Budget = PHASE2_BUDGET;
    if (PER_ACCOUNT > 0) {
        let pool = POOL_SIZE;
        if (pool <= 0) {
            const tokens = readTokens();
            pool = tokens ? tokens.filter(t => t && !t.invalid).length : 0;
        }
        const total = PER_ACCOUNT * pool;
        phase1Budget = Math.min(PHASE1_BUDGET, total);
        phase2Budget = total - phase1Budget;
        console.log(`Режим «${PER_ACCOUNT} на аккаунт»: пул=${pool} → всего ${total} (последовательно ${phase1Budget} + параллельно ${phase2Budget})`);
    }

    console.log(`\n═══ ФАЗА 1: последовательно (${phase1Budget} запросов) ═══`);
    await burst('phase1', phase1Budget, 1, state);

    if (state.total429 === 0 && state.totalErr < Math.max(3, phase1Budget / 2) && phase2Budget > 0) {
        console.log(`\n═══ ФАЗА 2: параллельно concurrency=${CONCURRENCY} (${phase2Budget} запросов) ═══`);
        await burst('phase2', state.next + phase2Budget - 1, CONCURRENCY, state);
    } else {
        console.log('\nПропускаем фазу 2 (уже есть 429 или слишком много ошибок).');
    }

    printSummary(state);
    await monitorRecovery(state, RECOVERY_WINDOW_S);
    process.exit(0);
}

main().catch(e => { console.error('STRESS ERROR:', e); process.exit(1); });
