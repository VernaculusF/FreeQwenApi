// probe_accounts.js — для каждого аккаунта делает create-chat + completion и
// классифицирует состояние: PUNISH (x5sec-челлендж, отвечает быстро) или OK
// (чистый аккаунт, реальный ответ).
//
// Режимы:
//   (по умолчанию) raw Node fetch БЕЗ cookies — быстрая проверка «со стороны
//     сервера»: если IP/фейспринт помечен WAF, так будут отвечать ВСЕ аккаунты
//     (14/14 PUNISH за ~0.4с). Это проверка источника, а не аккаунтов.
//   --browser — полная проверка через браузер: у каждого аккаунта свой
//     изолированный контекст с ЕГО cookies (session/accounts/<id>/cookies.json),
//     при челлендже решаем слайдер автоматически и сохраняем свежие cookies.
//     Это и есть «авто-солв + смена фейспринта + cool-down» в одном прогоне.
//
// Запуск на сервере:
//   node scripts/probe_accounts.js [--timeout-ms 10000] [--limit N]
//   node scripts/probe_accounts.js --browser [--timeout-ms 10000] [--delay-ms 3000] [--limit N]
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { initBrowser, shutdownBrowser, getAccountBrowserContext, getPageFromContext } from '../src/browser/browser.js';
import { extractPunishUrl, solveX5secChallenge } from '../src/browser/x5secSolver.js';
import { saveSession } from '../src/browser/session.js';
import { withOperationGuard } from '../src/utils/operationGuard.js';
import { CHAT_PAGE_URL, QWEN_PROBE_DELAY_MS } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, '..', 'session', 'tokens.json');
const BASE = 'https://chat.qwen.ai';
const CREATE_URL = `${BASE}/api/v2/chats/new`;
const COMPLETE_URL = `${BASE}/api/v2/chat/completions`;

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
    const idx = args.indexOf(name);
    const raw = idx !== -1 ? args[idx + 1] : undefined;
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) ? n : fallback;
};
const BROWSER_MODE = args.includes('--browser');
const TIMEOUT = argValue('--timeout-ms', 10_000);
const DELAY_MS = argValue('--delay-ms', QWEN_PROBE_DELAY_MS);

const allTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')).filter(t => t && !t.invalid);
const LIMIT = Math.min(argValue('--limit', allTokens.length), allTokens.length);
const tokens = allTokens.slice(0, LIMIT);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function headers(token) {
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

const isPunish = (text) => /_____tmd_____|\/punish|x5sec/i.test(text || '');

function buildProbePayload(chatId = null) {
    const parentId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();
    return {
        stream: true, version: '2.1', incremental_output: true,
        chat_id: chatId, // API требует chat_id в теле, не только в URL (?chat_id=)
        chat_mode: 'normal',
        messages: [{
            fid: userMessageId, parentId, parent_id: parentId, role: 'user', content: 'probe',
            chat_type: 't2t', sub_chat_type: 't2t', timestamp: Math.floor(Date.now() / 1000),
            user_action: 'chat', models: ['qwen3.8-max'], files: [], childrenIds: [assistantChildId],
            extra: { meta: { subChatType: 't2t' } }, feature_config: { thinking_enabled: false, output_schema: 'phase' }
        }],
        model: 'qwen3.8-max', parent_id: parentId, timestamp: Math.floor(Date.now() / 1000)
    };
}

// ─── raw fetch (без cookies): быстрая проверка «со стороны сервера» ─────────
async function probeRaw(tokenObj) {
    const t0 = Date.now();
    try {
        const create = await fetch(CREATE_URL, {
            method: 'POST',
            headers: headers(tokenObj.token),
            body: JSON.stringify({ title: 'probe', models: ['qwen3.8-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }),
            signal: AbortSignal.timeout(TIMEOUT)
        });
        const createText = await create.text();
        let chatId = null;
        try { chatId = JSON.parse(createText)?.data?.id; } catch { /* no */ }
        if (!chatId) {
            const verdict = isPunish(createText) ? 'PUNISH' : 'CREATE-FAIL';
            return { id: tokenObj.id, verdict, ms: Date.now() - t0, detail: `${create.status} ${createText.slice(0, 60).replace(/\s+/g, ' ')}` };
        }
        const comp = await fetch(`${COMPLETE_URL}?chat_id=${chatId}`, {
            method: 'POST', headers: headers(tokenObj.token), body: JSON.stringify(buildProbePayload(chatId)),
            signal: AbortSignal.timeout(TIMEOUT)
        });
        const compText = await comp.text();
        const verdict = isPunish(compText) ? 'PUNISH' : (comp.ok ? 'OK' : `HTTP ${comp.status}`);
        return { id: tokenObj.id, verdict, ms: Date.now() - t0, detail: compText.slice(0, 60).replace(/\s+/g, ' ') };
    } catch (e) {
        return { id: tokenObj.id, verdict: 'ERR', ms: Date.now() - t0, detail: e.message?.slice(0, 60) };
    }
}

// ─── browser-проба: контекст аккаунта (его cookies) + авто-солв ──────────────
async function probeInPage(page, tokenObj) {
    const t0 = Date.now();
    // page.evaluate ждёт ПОЛНОГО тела: стриминговый completion при WAF-висении
    // может не завершиться никогда. Гард режет по таймауту, страницу закрывает
    // вызывающий код в finally (убивая висящий fetch).
    // Таймаут probe fetch = HANG_DETECT_MS: после него считаем запрос
    // «WAF-висением» и переходим к пробе + солву, а не ждём бесконечно.
    const guarded = (fn) => withOperationGuard(fn, { timeoutMs: HANG_DETECT_MS, label: 'probe fetch' });
    try {
        const createResult = await guarded(page.evaluate(async (data) => {
            try {
                const res = await fetch(data.createUrl, {
                    method: 'POST', credentials: 'same-origin', headers: data.headers,
                    body: JSON.stringify({ title: 'probe', models: ['qwen3.8-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() })
                });
                return { status: res.status, body: await res.text() };
            } catch (e) { return { error: e.toString() }; }
        }, { createUrl: CREATE_URL, headers: headers(tokenObj.token) }));

        if (createResult.error) {
            return { id: tokenObj.id, verdict: 'ERR', ms: Date.now() - t0, detail: createResult.error.slice(0, 60) };
        }
        let chatId = null;
        try { chatId = JSON.parse(createResult.body)?.data?.id; } catch { /* no */ }
        if (!chatId) {
            const verdict = isPunish(createResult.body) ? 'PUNISH' : 'CREATE-FAIL';
            return {
                id: tokenObj.id,
                verdict,
                ms: Date.now() - t0,
                detail: `${createResult.status} ${createResult.body.slice(0, 60).replace(/\s+/g, ' ')}`,
                punishUrl: verdict === 'PUNISH' ? extractPunishUrl(createResult.body) : null
            };
        }

        const compResult = await guarded(page.evaluate(async (data) => {
            try {
                const res = await fetch(`${data.completeUrl}?chat_id=${data.chatId}`, {
                    method: 'POST', credentials: 'same-origin', headers: data.headers, body: JSON.stringify(data.payload)
                });
                return { status: res.status, body: await res.text() };
            } catch (e) { return { error: e.toString() }; }
        }, { completeUrl: COMPLETE_URL, chatId, headers: headers(tokenObj.token), payload: buildProbePayload(chatId) }));

        if (compResult.error) {
            return { id: tokenObj.id, verdict: 'ERR', ms: Date.now() - t0, detail: compResult.error.slice(0, 60) };
        }
        // Классификация по телу: punish-маркеры, JSON success:false (код ошибки),
        // SSE с контентом, иначе — по HTTP-статусу.
        let verdict;
        let code = '';
        let punishUrl = null;
        if (isPunish(compResult.body)) {
            verdict = 'PUNISH';
            punishUrl = extractPunishUrl(compResult.body);
        } else if (compResult.body.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(compResult.body);
                if (parsed?.success === false) {
                    const c = parsed?.code || parsed?.data?.code || '';
                    code = String(c || 'success:false');
                    const ret = Array.isArray(parsed?.ret) ? parsed.ret.join(' ') : '';
                    verdict = /FAIL_SYS_USER_VALIDATE|RGV587/i.test(ret) ? 'PUNISH'
                        : /RateLimited/i.test(code) ? 'RATELIMIT'
                            : 'API-ERR';
                } else if (parsed?.success === true || parsed?.choices || parsed?.id) {
                    verdict = 'OK';
                } else {
                    verdict = 'API-ERR';
                }
            } catch {
                verdict = compResult.status >= 200 && compResult.status < 300 ? 'OK' : `HTTP ${compResult.status}`;
            }
        } else {
            verdict = compResult.status >= 200 && compResult.status < 300 ? 'OK' : `HTTP ${compResult.status}`;
        }
        const detail = code ? `${code}: ${compResult.body.slice(0, 300).replace(/\s+/g, ' ')}` : compResult.body.slice(0, 100).replace(/\s+/g, ' ');
        return {
            id: tokenObj.id,
            verdict,
            ms: Date.now() - t0,
            detail,
            punishUrl
        };
    } catch (e) {
        return { id: tokenObj.id, verdict: 'ERR', ms: Date.now() - t0, detail: e.message?.slice(0, 60) };
    }
}

// WAF-висение: браузерный fetch НЕ возвращает тело (ни punish-страницу, ни
// ответ) — просто висит. Реальный прокси лечит это пробой через Node fetch
// (отдаёт punish URL за ~0.5с) + солвом слайдера. Здесь тот же цикл.
const HANG_DETECT_MS = Math.min(TIMEOUT, 10_000);

async function fetchPunishUrlViaRawFetch(tokenObj) {
    try {
        const create = await fetch(CREATE_URL, {
            method: 'POST',
            headers: headers(tokenObj.token),
            body: JSON.stringify({ title: 'probe', models: ['qwen3.8-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }),
            signal: AbortSignal.timeout(TIMEOUT)
        });
        const text = await create.text();
        return {
            punishUrl: extractPunishUrl(text),
            status: create.status,
            snippet: text.slice(0, 120).replace(/\s+/g, ' ')
        };
    } catch (e) {
        return { punishUrl: null, error: e.message?.slice(0, 60) };
    }
}

async function probeBrowser(tokenObj) {
    const t0 = Date.now();
    try {
        // Изолированный контекст аккаунта: cookies ТОЛЬКО этого аккаунта.
        const ctx = await getAccountBrowserContext(tokenObj.id);
        if (!ctx) return { id: tokenObj.id, verdict: 'ERR', ms: Date.now() - t0, detail: 'браузер не инициализирован' };

        const page = await getPageFromContext(ctx);
        let solved = false;
        let solveMs = null;
        try {
            const nav = await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
            let result = await probeInPage(page, tokenObj);

            // Триггер челленджа:
            //  - PUNISH с punishUrl — WAF отдал страницу капчи напрямую;
            //  - таймаут probe fetch — WAF-висение (бан-висение x5sec в браузере),
            //    получаем punish URL через Node fetch и решаем тем же циклом, что прокси.
            const hung = result.verdict === 'ERR' && /таймаут/.test(result.detail || '');
            let punishUrl = (result.verdict === 'PUNISH' && result.punishUrl) || null;
            if (hung && !punishUrl) {
                const rawInfo = await fetchPunishUrlViaRawFetch(tokenObj);
                punishUrl = rawInfo.punishUrl;
                if (!punishUrl && !rawInfo.error && rawInfo.status === 200) {
                    // raw-проба прошла (200), браузер завис — WAF-«мерцание».
                    // Повторяем браузерную пробу один раз, прежде чем вешать вердикт.
                    await sleep(2_000);
                    const retry = await probeInPage(page, tokenObj);
                    if (retry.verdict !== 'ERR') result = retry;
                }
                const rawDesc = punishUrl ? 'да' : (rawInfo.error ? `ошибка: ${rawInfo.error}` : `нет (HTTP ${rawInfo.status}: ${rawInfo.snippet})`);
                result = { ...result, detail: `${result.detail}; страница после goto: ${page.url().slice(0, 80)}; raw-проба: ${rawDesc}` };
            }

            if (punishUrl) {
                const solveT0 = Date.now();
                const ok = await solveX5secChallenge(page, punishUrl);
                solveMs = Date.now() - solveT0;
                solved = ok;
                if (ok) {
                    try { await saveSession(page, tokenObj.id); } catch { /* не критично для пробы */ }
                    // после солва пробуем ещё раз — сессия должна быть разблокирована
                    await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
                    const retry = await probeInPage(page, tokenObj);
                    if (retry.verdict !== 'ERR') result = retry;
                }
            }

            return {
                id: tokenObj.id,
                verdict: result.verdict,
                ms: Date.now() - t0,
                solve: solved ? `SOLVED ${solveMs}мс` : (solveMs !== null ? `SOLVE-FAIL` : ''),
                detail: result.detail || ''
            };
        } finally {
            await page.close().catch(() => {});
        }
    } catch (e) {
        return { id: tokenObj.id, verdict: 'ERR', ms: Date.now() - t0, detail: e.message?.slice(0, 60) };
    }
}

async function main() {
    console.log(`Аккаунтов: ${tokens.length}${BROWSER_MODE ? ' (режим --browser: изоляция cookies + авто-солв)' : ' (raw fetch, без cookies — проверка источника IP/фейспринта)'}`);
    if (BROWSER_MODE) {
        console.log('Инициализация headless-браузера...');
        const ok = await initBrowser(false);
        if (!ok) { console.error('Не удалось запустить браузер'); process.exit(1); }
    }

    const results = [];
    for (const t of tokens) {
        const r = BROWSER_MODE ? await probeBrowser(t) : await probeRaw(t);
        results.push(r);
        console.log(`${r.id.slice(0, 20)}  ${r.verdict.padEnd(10)} ${String(r.ms).padStart(5)}ms  ${(r.solve ? r.solve.padEnd(14) : '')}${r.detail || ''}`);
        if (DELAY_MS > 0 && tokens.length > 1) {
            await sleep(DELAY_MS);
        }
    }

    const punish = results.filter(r => r.verdict === 'PUNISH').length;
    const ok = results.filter(r => r.verdict === 'OK').length;
    const rest = results.filter(r => !['PUNISH', 'OK'].includes(r.verdict));
    const restSummary = rest.length
        ? `, остальное: ${rest.map(r => `${r.verdict}=${rest.filter(x => x.verdict === r.verdict).length}`).filter((v, i, a) => a.indexOf(v) === i).join(' ')}`
        : '';
    const solved = results.filter(r => typeof r.solve === 'string' && r.solve.startsWith('SOLVED')).length;
    console.log(`\nИтог: PUNISH=${punish}, OK=${ok}${restSummary}${BROWSER_MODE ? `, солвов после челленджа: ${solved}` : ''}`);
    if (BROWSER_MODE) console.log('Примечание: PUNISH/API-ERR в --browser с неудачным солвом = WAF на IP/фейспринте сервера; OK после солва = аккаунт рабочий.');

    if (BROWSER_MODE) await shutdownBrowser();
    process.exit(ok > 0 ? 0 : 1);
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
