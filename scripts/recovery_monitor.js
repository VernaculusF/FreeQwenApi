// recovery_monitor.js — мониторинг восстановления аккаунтов после троттла.
// Каждые 5 минут делает один chat-completion запрос через прокси и пишет
// результат с таймстампом. Первый успешный ответ = момент разблокировки.
//
// Использование:
//   node scripts/recovery_monitor.js --port 3264 [--interval-s 300] [--max-runs 18]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, '..', 'recovery_monitor.log');

const args = process.argv.slice(2);
const get = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const PORT = Number(get('--port', 3264));
const INTERVAL_S = Number(get('--interval-s', 300));
const MAX_RUNS = Number(get('--max-runs', 18));
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function log(line) {
    const entry = `[${nowIso()}] ${line}`;
    console.log(entry);
    fs.appendFileSync(LOG, entry + '\n');
}

async function probe(run) {
    const t0 = Date.now();
    try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen3.8-max',
                messages: [{ role: 'user', content: 'recovery probe' }],
                stream: false
            }),
            signal: AbortSignal.timeout(60_000)
        });
        const text = await res.text();
        const ok = res.ok && text.length > 0;
        log(`run#${run} ${ok ? 'RECOVERED ✓' : 'FAIL'} HTTP:${res.status} ${Date.now() - t0}ms body:${text.slice(0, 90).replace(/\s+/g, ' ')}`);
        return ok;
    } catch (e) {
        log(`run#${run} FAIL (${Date.now() - t0}ms) error: ${e.message?.slice(0, 80)}`);
        return false;
    }
}

async function main() {
    log(`Мониторинг восстановления запущен: порт ${PORT}, интервал ${INTERVAL_S}с, максимум ${MAX_RUNS} прогонов`);
    let recoveredAt = null;
    for (let run = 1; run <= MAX_RUNS; run++) {
        const ok = await probe(run);
        if (ok) {
            recoveredAt = nowIso();
            log(`ВОССТАНОВЛЕНИЕ ЗАФИКСИРОВАНО в ${recoveredAt} (прогон #${run})`);
            break;
        }
        if (run < MAX_RUNS) await sleep(INTERVAL_S * 1000);
    }
    if (!recoveredAt) log(`Окно мониторинга истекло (${MAX_RUNS} прогонов) без восстановления`);
    process.exit(0);
}

main().catch(e => { log(`МОНИТОРИНГ ОШИБКА: ${e.message}`); process.exit(1); });
