// repair_account_cookies.js — чинит разрыв «токен ⇄ cookies».
//
// Баг авторизации: saveSessionPuppeteer() сохраняет cookies под СВОИМ новым
// acc_<id>, а addAccountInteractive() создаёт для токена ДРУГОЙ acc_<id>.
// Итог: у аккаунтов из tokens.json нет своих cookies.json, а все чужие
// «сиротские» cookies смешиваются в общем браузере — каждый токен ходит с
// чужими cookies сессии (WAF челленджит/вешает всё подряд).
//
// Проход авторизации создаёт каталог cookies на ~100-170мс РАНЬШЕ каталога
// токена (тот же процесс, соседние вызовы Date.now()). По этому признаку
// подбираем каждому токену его каталог cookies и копируем cookies.json.
// Копирование неразрушающее: сиротские каталоги не удаляются.
//
// Запуск: node scripts/repair_account_cookies.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTokens } from '../src/api/tokenManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = path.join(__dirname, '..', 'session', 'accounts');
// Окно поиска «того же прохода авторизации», мс. Каталог cookies создаётся на
// ~100-170мс раньше каталога токена; окно 10с исключает случайные старые сессии.
const PAIR_WINDOW_MS = 10_000;

function parseId(id) {
    const m = String(id).match(/^acc_(\d+)$/);
    return m ? Number(m[1]) : NaN;
}

const tokenIds = loadTokens().map(t => t.id).filter(id => Number.isFinite(parseId(id)));
const cookieDirs = fs.readdirSync(ACCOUNTS_DIR)
    .filter(d => fs.existsSync(path.join(ACCOUNTS_DIR, d, 'cookies.json')))
    .map(d => ({ id: d, ts: parseId(d) }))
    .filter(x => Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);

if (!tokenIds.length) {
    console.log('В tokens.json нет аккаунтов — нечего чинить.');
    process.exit(0);
}

let fixed = 0;
let skipped = 0;
let missing = 0;
for (const tokenId of tokenIds) {
    const ts = parseId(tokenId);
    const target = path.join(ACCOUNTS_DIR, tokenId, 'cookies.json');
    if (fs.existsSync(target)) {
        // «Обрезанная» сессия (например, 1-2 cookies после солва без полного
        // набора) считается битой — заменяем полной из парного каталога.
        let size = 0;
        try {
            const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
            size = Array.isArray(parsed) ? parsed.length : 0;
        } catch { size = 0; }
        if (size >= 5) {
            skipped++; // уже есть полноценная своя сессия
            continue;
        }
        console.log(`${tokenId}: файл cookies битый (${size} cookies) — перезаписываем`);
    }
    // ближайший каталог cookies, созданный ЧУТЬ РАНЬШЕ того же прохода
    const match = cookieDirs.filter(c => c.ts < ts && ts - c.ts <= PAIR_WINDOW_MS).pop();
    if (!match) {
        console.log(`${tokenId}: каталог cookies не найден (${ts}мс)`);
        missing++;
        continue;
    }
    fs.copyFileSync(path.join(ACCOUNTS_DIR, match.id, 'cookies.json'), target);
    console.log(`${tokenId} <- ${match.id} (разница ${ts - match.ts}мс)`);
    fixed++;
}

console.log(`\nГотово: скопировано ${fixed}, уже было ${skipped}, не найдено ${missing} (всего ${tokenIds.length}).`);
console.log('Теперь у каждого аккаунта своя cookie-сессия — изолированные контексты (getAccountBrowserContext) заработают как задумано.');
process.exit(missing > 0 ? 1 : 0);
