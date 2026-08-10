// test_x5sec_solver.js — живой тест солвера слайдера x5sec.
// Получает свежий punish URL, открывает в браузере, вызывает solveSliderCaptcha,
// печатает результат и финальный URL.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
import { solveSliderCaptcha, isX5secPage } from '../src/browser/x5secSolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, '..', 'session', 'tokens.json');
const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')).filter(t => t && !t.invalid);
const token = tokens[0]?.token || tokens[0]?.auth_token;

const BASE = 'https://chat.qwen.ai';

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

async function getFreshPunishUrl() {
    const createRes = await fetch(`${BASE}/api/v2/chats/new`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ title: 'probe', models: ['qwen3.8-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }),
        signal: AbortSignal.timeout(15_000)
    });
    const chatId = JSON.parse(await createRes.text())?.data?.id;
    const parentId = crypto.randomUUID();
    const payload = {
        stream: true, version: '2.1', incremental_output: true, chat_id: chatId,
        chat_mode: 'normal',
        messages: [{
            fid: crypto.randomUUID(), parentId, parent_id: parentId, role: 'user',
            content: 'probe', chat_type: 't2t', sub_chat_type: 't2t',
            timestamp: Math.floor(Date.now() / 1000), user_action: 'chat',
            models: ['qwen3.8-max'], files: [], childrenIds: [crypto.randomUUID()],
            extra: { meta: { subChatType: 't2t' } },
            feature_config: { thinking_enabled: false, output_schema: 'phase' }
        }],
        model: 'qwen3.8-max', parent_id: parentId, timestamp: Math.floor(Date.now() / 1000)
    };
    const res = await fetch(`${BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
        method: 'POST', headers: headers(), body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000)
    });
    const body = await res.text();
    const m = body.match(/window\.location\.replace\("([^"]+)"\)/);
    if (!m) { console.error('Нет punish URL в теле:', body.slice(0, 200)); process.exit(1); }
    return m[1];
}

async function main() {
    const punishUrl = await getFreshPunishUrl();
    console.log('punish URL получен, открываю...');

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu', '--disable-web-security'],
        defaultViewport: { width: 1280, height: 800 },
        protocolTimeout: 60_000,
        ignoreHTTPSErrors: true
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    await page.goto(punishUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));

    console.log('isX5secPage:', await isX5secPage(page));
    console.log('URL до:', page.url().slice(0, 80));
    console.log('Заголовок:', await page.title());

    const solved = await solveSliderCaptcha(page, { maxAttempts: 3 });
    console.log('РЕЗУЛЬТАТ:', solved ? '✓ РЕШЕНО' : '✗ НЕ РЕШЕНО');

    await new Promise(r => setTimeout(r, 3000));
    console.log('URL после:', page.url().slice(0, 120));
    console.log('Заголовок после:', await page.title().catch(() => '(closed)'));
    await page.screenshot({ path: '/tmp/x5sec_after.png', fullPage: true });
    console.log('Скриншот после: /tmp/x5sec_after.png');

    await browser.close();
    process.exit(0);
}

main().catch(e => { console.error('ERR:', e); process.exit(1); });
