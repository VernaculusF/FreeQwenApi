#!/usr/bin/env node
// workers.js — запуск N воркеров прокси с АВТО-РАСПРЕДЕЛЕНИЕМ аккаунтов.
//
//   npm run workers -- --workers 3
//   npm run workers -- --workers 3 --base-port 3264 --host 127.0.0.1
//
// Каждый воркер — отдельный процесс `node index.js` на своём порту
// (base-port + k). Аккаунты распределяются детерминированно по FNV-1a от id
// аккаунта: один и тот же аккаунт всегда попадает в одну и ту же долю, а
// добавление/удаление аккаунтов не «перетасовывает» остальных.
//
// Поведение:
//   - пустые доли (воркеров больше, чем аккаунтов) не запускаются;
//   - упавшие воркеры автоматически перезапускаются с паузой;
//   - Ctrl+C / SIGTERM завершают все воркеры корректно.
//
// Все воркеры делят общий session/tokens.json (реестр аккаунтов), но каждый
// использует только свою долю. НОВЫЕ аккаунты, добавленные через
// `npm run auth -- --add`, подхватываются воркерами БЕЗ перезапуска.

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTokens, fnv1a } from '../src/api/tokenManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_JS = path.join(__dirname, '..', 'index.js');

const RESTART_DELAY_MS = 2000;

function printHelp() {
    console.log(`
Запуск N воркеров прокси с авто-распределением аккаунтов.

Использование:
  npm run workers -- --workers N [--base-port P] [--host H]

Опции:
  -w, --workers N      количество воркеров (по умолчанию 2)
  -p, --base-port P    порт первого воркера (по умолчанию 3264);
                       воркер k слушает порт P + k
      --host H         хост (по умолчанию 127.0.0.1)
  -h, --help           эта справка

Примеры:
  npm run workers -- --workers 2              # 2 воркера: 3264, 3265
  npm run workers -- --workers 4 --base-port 8000
`);
}

function parseArgs(argv) {
    const args = {
        workers: Number(process.env.WORKERS) || 2,
        basePort: Number(process.env.WORKER_BASE_PORT) || 3264,
        host: process.env.HOST || '127.0.0.1'
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        if (arg === '--workers' || arg === '-w') args.workers = Number(next());
        else if (arg === '--base-port' || arg === '-p') args.basePort = Number(next());
        else if (arg === '--host') args.host = next();
        else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    }
    if (!Number.isInteger(args.workers) || args.workers < 1) {
        console.error('Количество воркеров должно быть целым числом >= 1.');
        process.exit(1);
    }
    if (!Number.isInteger(args.basePort) || args.basePort <= 0 || args.basePort > 65535) {
        console.error('Некорректный base-port.');
        process.exit(1);
    }
    return args;
}

function timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
    console.log(`[${timestamp()}] [workers] ${msg}`);
}

// ─── Основная логика ─────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const { workers: N, basePort, host } = args;

const allTokens = loadTokens();
if (!allTokens.length) {
    log('В session/tokens.json нет аккаунтов. Сначала добавьте их: npm run auth -- --add');
    process.exit(1);
}

// Авто-распределение: доля k = аккаунты с fnv1a(id) % N === k.
const slices = Array.from({ length: N }, () => []);
for (const token of allTokens) {
    if (token && token.id) slices[fnv1a(token.id) % N].push(token);
}

console.log(`\nВоркеров: ${N} | Аккаунтов в реестре: ${allTokens.length}`);
for (let k = 0; k < N; k++) {
    const ids = slices[k].map(t => t.id);
    const port = basePort + k;
    if (!ids.length) {
        console.log(`  воркер ${k} — порт ${port}: аккаунтов 0 (пропущен)`);
    } else {
        console.log(`  воркер ${k} — порт ${port}: аккаунтов ${ids.length}  [${ids.join(', ')}]`);
    }
}
console.log('');

const children = new Map(); // k -> child
let shuttingDown = false;

function startWorker(k) {
    if (shuttingDown) return;
    if (!slices[k].length) return;
    const port = basePort + k;
    const child = spawn(process.execPath, [INDEX_JS], {
        env: {
            ...process.env,
            PORT: String(port),
            HOST: host,
            ACCOUNT_SUBSET: `${k}/${N}`,
            NON_INTERACTIVE: '1',
            SKIP_ACCOUNT_MENU: '1'
        },
        stdio: ['ignore', 'inherit', 'inherit']
    });
    children.set(k, child);
    log(`Воркер ${k} запущен (порт ${port}, аккаунтов ${slices[k].length}). PID ${child.pid}`);

    child.on('exit', (code, signal) => {
        children.delete(k);
        if (shuttingDown) return;
        log(`Воркер ${k} (порт ${port}) завершился (${signal || `код ${code}`}). Перезапуск через ${RESTART_DELAY_MS / 1000}с...`);
        setTimeout(() => startWorker(k), RESTART_DELAY_MS);
    });
}

for (let k = 0; k < N; k++) startWorker(k);

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Получен ${signal}. Останавливаем все воркеры...`);
    for (const child of children.values()) {
        try { child.kill('SIGTERM'); } catch { /* уже завершён */ }
    }
    // Если воркеры не завершились за 5 секунд — принудительно.
    setTimeout(() => {
        for (const child of children.values()) {
            try { child.kill('SIGKILL'); } catch { /* уже завершён */ }
        }
        process.exit(0);
    }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`Готово: ${N - slices.filter(s => !s.length).length}/${N} воркеров работают. URLs:`);
for (let k = 0; k < N; k++) {
    if (slices[k].length) console.log(`  http://${host}:${basePort + k}/api`);
}
console.log('Нажмите Ctrl+C для остановки всех воркеров.');
