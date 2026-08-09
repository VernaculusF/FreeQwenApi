#!/usr/bin/env node
// Массовый импорт токенов Qwen — «много акков за раз», без интерактивного браузера.
//
// Форматы входа (файл или stdin через '-'):
//   eyJ...токен1
//   eyJ...токен2
//   # комментарии и пустые строки игнорируются
//   имя_аккаунта=eyJ...токен3          (именованный аккаунт)
//   ["eyJ...", "eyJ..."]                (JSON-массив строк)
//   [{"token": "eyJ...", "id": "alice"}] (JSON-массив объектов)
//
// Запуск:
//   node scripts/importTokens.js tokens.txt
//   cat tokens.txt | node scripts/importTokens.js -
//   node scripts/importTokens.js tokens.txt --check     # пинг каждого токена
//   node scripts/importTokens.js tokens.txt --prefix acc_ --strict
//
// --check: инициализирует headless-браузер и проверяет каждый токен лёгким ping
// (как tokenHealthCheck): UNAUTHORIZED -> invalid, RATELIMIT -> resetAt,
// ERROR -> токен не трогаем. Требует доступный Chromium (CHROME_PATH при
// необходимости) и сеть до chat.qwen.ai.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { loadTokens, saveTokens, markInvalidByToken, markRateLimitedByToken } from '../src/api/tokenManager.js';
import { parseTokenInput, buildImportPlan, isJwtLikeToken } from '../src/utils/tokenImport.js';
import { pingQwenTokenWithRetry } from '../src/api/qwenPing.js';
import { initBrowser, shutdownBrowser } from '../src/browser/browser.js';
import { logInfo, logError, logWarn } from '../src/logger/index.js';
import { SESSION_DIR, ACCOUNTS_DIR } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, '..', SESSION_DIR);

function parseArgs(argv) {
    const args = { file: null, check: false, strict: false, mark: true, prefix: 'acc_' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--check') args.check = true;
        else if (arg === '--strict') args.strict = true;
        else if (arg === '--no-mark') args.mark = false;
        else if (arg === '--prefix' && argv[i + 1]) {
            args.prefix = argv[i + 1];
            i++;
        } else if (arg === '-') args.file = '-';
        else if (!arg.startsWith('-') && !args.file) args.file = arg;
    }
    return args;
}

function printUsage() {
    console.log('Импорт токенов Qwen: node scripts/importTokens.js <файл|-|stdin> [--check] [--strict] [--prefix acc_] [--no-mark]');
}

async function readInput(file) {
    if (!file) {
        printUsage();
        return null;
    }
    if (file === '-') {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
    }
    if (!fs.existsSync(file)) {
        logError(`Файл не найден: ${file}`);
        return null;
    }
    return fs.readFileSync(file, 'utf8');
}

function ensureAccountDir(id) {
    const accountDir = path.resolve(SESSION_PATH, ACCOUNTS_DIR, id);
    if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });
    return accountDir;
}

async function checkTokens(entries, { mark = true } = {}) {
    logInfo(`Проверка ${entries.length} токенов лёгким ping (headless-браузер)...`);
    const ok = await initBrowser(false);
    if (!ok) {
        logError('Не удалось запустить браузер для проверки токенов. Пропускаем --check.');
        return;
    }

    try {
        const summary = { ok: 0, unauthorized: 0, ratelimited: 0, errors: 0 };
        for (const entry of entries) {
            let status;
            try {
                status = await pingQwenTokenWithRetry(entry.token);
            } catch (e) {
                logWarn(`Проверка ${entry.id}: ошибка — ${e.message}`);
                status = 'ERROR';
            }

            if (status === 'OK') {
                summary.ok++;
                logInfo(`  ${entry.id}: OK`);
            } else if (status === 'UNAUTHORIZED') {
                summary.unauthorized++;
                logWarn(`  ${entry.id}: UNAUTHORIZED (401) — токен недействителен`);
                if (mark) markInvalidByToken(entry.token);
            } else if (status === 'RATELIMIT') {
                summary.ratelimited++;
                logWarn(`  ${entry.id}: RATELIMIT (429) — помечен на сброс`);
                if (mark) markRateLimitedByToken(entry.token, 24);
            } else {
                summary.errors++;
                logWarn(`  ${entry.id}: ERROR (сеть/WAF) — токен не трогаем, проверится позже`);
            }
        }
        logInfo(`Итог проверки: OK: ${summary.ok}, недействительных: ${summary.unauthorized}, rate-limit: ${summary.ratelimited}, ошибок: ${summary.errors}.`);
    } finally {
        await shutdownBrowser();
    }
}

/**
 * Импорт токенов из файла/stdin. Экспортируется, чтобы scripts/auth.js мог
 * вызывать его как `npm run auth -- --import <файл> [--check]`.
 *
 * @param {string} file — путь к файлу или '-'
 * @param {string[]} [rawArgs] — остальные CLI-аргументы (--check, --strict, --prefix, --no-mark)
 * @returns {Promise<{added: number, duplicates: number, total: number, checked: boolean}>}
 */
export async function importTokensFromFile(file, rawArgs = []) {
    const args = parseArgs(rawArgs);
    const text = await readInput(file);
    if (text === null) throw new Error('Не удалось прочитать входные данные.');

    const incoming = parseTokenInput(text);
    if (!incoming.length) {
        throw new Error('Не найдено ни одного токена во входных данных.');
    }

    const nonJwt = incoming.filter(item => !isJwtLikeToken(item.token));
    if (nonJwt.length) {
        const message = `${nonJwt.length} из ${incoming.length} токенов не похожи на JWT (eyJ...).`;
        if (args.strict) {
            throw new Error(`${message} Импорт отменён (--strict).`);
        }
        logWarn(`${message} Импортируем как есть.`);
    }

    const existing = loadTokens();
    const { toAdd, duplicates } = buildImportPlan(existing, incoming, { prefix: args.prefix });

    if (toAdd.length) {
        const list = [...existing, ...toAdd.map(({ id, token }) => ({ id, token, resetAt: null }))];
        saveTokens(list);

        for (const { id, token } of toAdd) {
            const accountDir = ensureAccountDir(id);
            fs.writeFileSync(path.resolve(accountDir, 'token.txt'), token, 'utf8');
        }

        logInfo(`Добавлено аккаунтов: ${toAdd.length}. Всего: ${list.length}.`);
    } else {
        logInfo('Новых аккаунтов нет — все токены уже есть.');
    }
    if (duplicates > 0) logInfo(`Пропущено дубликатов: ${duplicates}.`);
    for (const { id } of toAdd) logInfo(`  + ${id}`);

    let checked = false;
    if (args.check && toAdd.length) {
        checked = true;
        await checkTokens(toAdd, { mark: args.mark });
    }

    return { added: toAdd.length, duplicates, total: loadTokens().length, checked };
}

// Прямой запуск: node scripts/importTokens.js <файл> [--check] ...
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    importTokensFromFile(process.argv[2], process.argv.slice(2))
        .catch(error => {
            logError('Импорт токенов не удался', error);
            process.exit(1);
        });
}
