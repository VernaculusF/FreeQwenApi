import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    classifyQwenError,
    classifyPingResult,
    classifyPingResponse,
    pingQwenTokenWithRetry,
    buildQwenRequestHeaders
} from '../src/api/qwenPing.js';
import {
    isWafHtmlBlock,
    isAntiBotBody,
    isVerificationText,
    VERIFICATION_URL_RE
} from '../src/utils/verificationMarkers.js';

// ─── verificationMarkers (единый реестр маркеров) ───────────────────────────

test('isWafHtmlBlock: маркеры WAF Alibaba и сырой HTML', () => {
    assert.equal(isWafHtmlBlock('window.location.replace("/api/v2/chat/completions/_____tmd_____/punish?x5secdata=abc")'), true);
    assert.equal(isWafHtmlBlock('x5sec'), true);
    assert.equal(isWafHtmlBlock('{"action" : "captcha", "url":"..."}'), true);
    assert.equal(isWafHtmlBlock('<!DOCTYPE html><html><body>challenge</body></html>'), true);
    assert.equal(isWafHtmlBlock('{"choices":[]}'), false);
    assert.equal(isWafHtmlBlock(''), false);
});

test('isAntiBotBody: rgv587/fail_sys_user_validate/window._config_+captcha', () => {
    assert.equal(isAntiBotBody('<!--rgv587_flag:sm-->'), true);
    assert.equal(isAntiBotBody('{"ret":["FAIL_SYS_USER_VALIDATE"]}'), true);
    assert.equal(isAntiBotBody('window._config_ = {"action":"captcha"}'), true);
    assert.equal(isAntiBotBody('pureCaptcha'), true);
    assert.equal(isAntiBotBody('{"success":true}'), false);
});

test('isVerificationText: фразы верификации на нескольких языках', () => {
    assert.equal(isVerificationText('Verify you are human to continue'), true);
    assert.equal(isVerificationText('Human verification required'), true);
    assert.equal(isVerificationText('Пожалуйста, подтвердите, что вы не робот'), true);
    assert.equal(isVerificationText('请完成人机验证'), true);
    assert.equal(isVerificationText('Введите验证码'), true);
    assert.equal(isVerificationText('Start a new chat with Qwen3'), false);
});

test('VERIFICATION_URL_RE: URL/заголовок верификации', () => {
    assert.equal(VERIFICATION_URL_RE.test('https://chat.qwen.ai/verification'), true);
    assert.equal(VERIFICATION_URL_RE.test('https://chat.qwen.ai/punish'), true);
    assert.equal(VERIFICATION_URL_RE.test('Verification'), true);
    assert.equal(VERIFICATION_URL_RE.test('https://chat.qwen.ai/'), false);
    assert.equal(VERIFICATION_URL_RE.test('Qwen Studio'), false);
});

// ─── classifyQwenError ───────────────────────────────────────────────────────

test('classifyQwenError: 401 и текст Unauthorized/Token has expired → unauthorized', () => {
    assert.equal(classifyQwenError({ status: 401 }).kind, 'unauthorized');
    assert.equal(classifyQwenError({ status: 200, errorBody: 'Unauthorized' }).kind, 'unauthorized');
    assert.equal(classifyQwenError({ status: 200, errorBody: 'Token has expired' }).kind, 'unauthorized');
});

test('classifyQwenError: 429, текст RateLimited и код RateLimited → ratelimit', () => {
    assert.equal(classifyQwenError({ status: 429 }).kind, 'ratelimit');
    assert.equal(classifyQwenError({ status: 200, errorBody: 'RateLimited' }).kind, 'ratelimit');
    assert.equal(classifyQwenError({ status: 200, code: 'RateLimited' }).kind, 'ratelimit');
    // Вложенный код: topLevelCode есть, но RateLimited в data.code — оба проверяются.
    assert.equal(classifyQwenError({ status: 200, code: ['OtherCode', 'RateLimited'] }).kind, 'ratelimit');
});

test('classifyQwenError: 5xx → transient, остальное → other', () => {
    assert.equal(classifyQwenError({ status: 502 }).kind, 'transient');
    assert.equal(classifyQwenError({ status: 500 }).kind, 'transient');
    assert.equal(classifyQwenError({ status: 200, errorBody: 'ok' }).kind, 'other');
    assert.equal(classifyQwenError({ status: 0 }).kind, 'other');
});

test('classifyQwenError: effectiveStatus нормализует 401/429', () => {
    assert.equal(classifyQwenError({ status: 200, errorBody: 'Unauthorized' }).effectiveStatus, 401);
    assert.equal(classifyQwenError({ status: 200, code: 'RateLimited' }).effectiveStatus, 429);
    assert.equal(classifyQwenError({ status: 503 }).effectiveStatus, 503);
});

// ─── classifyPingResult ──────────────────────────────────────────────────────

test('classifyPingResult: маппинг сырых статусов ping', () => {
    assert.deepEqual(classifyPingResult('OK'), { status: 'ok', authenticated: true, rateLimited: false });
    assert.deepEqual(classifyPingResult('UNAUTHORIZED'), { status: 'unauthorized', authenticated: false, rateLimited: false });
    assert.deepEqual(classifyPingResult('RATELIMIT'), { status: 'ratelimit', authenticated: true, rateLimited: true });
    assert.deepEqual(classifyPingResult('ERROR'), { status: 'error', authenticated: null, rateLimited: false });
});

// ─── classifyPingResponse (статус + тело) ───────────────────────────────────

test('classifyPingResponse: HTTP 200 с HTML-капчей WAF → ERROR (а не OK)', () => {
    const captchaHtml = '<!DOCTYPE html><html><head></head><body><script>window.location.replace("https://chat.qwen.ai//api/v2/chat/completions/_____tmd_____/punish?x5secdata=abc");</script></body></html>';
    assert.equal(classifyPingResponse({ ok: true, status: 200, body: captchaHtml }), 'ERROR');
    // Короткий фрагмент без тегов html, но с маркерами капчи
    assert.equal(classifyPingResponse({ ok: true, status: 200, body: 'window._config_ = {"action":"captcha","url":"..."}' }), 'ERROR');
    assert.equal(classifyPingResponse({ ok: true, status: 200, body: 'x5sec' }), 'ERROR');
    // HTML-страница любого содержания тоже не здоровый токен
    assert.equal(classifyPingResponse({ ok: true, status: 200, body: '<!DOCTYPE html><html>...</html>' }), 'ERROR');
});

test('classifyPingResponse: 200-е с JSON-телом ошибки → по содержанию', () => {
    assert.equal(classifyPingResponse({ ok: true, status: 200, body: '{"error":"Unauthorized"}' }), 'UNAUTHORIZED');
    assert.equal(classifyPingResponse({ ok: true, status: 200, body: 'Token has expired' }), 'UNAUTHORIZED');
    assert.equal(classifyPingResponse({ ok: true, status: 200, body: 'RateLimited' }), 'RATELIMIT');
});

test('classifyPingResponse: обычные статусы без капчи', () => {
    assert.equal(classifyPingResponse({ ok: true, status: 200, body: '{"choices":[]}' }), 'OK');
    assert.equal(classifyPingResponse({ ok: false, status: 400, body: '{"error":"bad"}' }), 'OK'); // исторический эвристик 400
    assert.equal(classifyPingResponse({ ok: false, status: 401 }), 'UNAUTHORIZED');
    assert.equal(classifyPingResponse({ ok: false, status: 403 }), 'UNAUTHORIZED');
    assert.equal(classifyPingResponse({ ok: false, status: 429 }), 'RATELIMIT');
    assert.equal(classifyPingResponse({ ok: false, status: 502 }), 'ERROR');
    assert.equal(classifyPingResponse({ ok: false, status: 0 }), 'ERROR');
    assert.equal(classifyPingResponse({}), 'ERROR');
});

// ─── pingQwenTokenWithRetry (единая политика retry) ─────────────────────────

test('pingQwenTokenWithRetry: успех с первой попытки — без повторов', async () => {
    let calls = 0;
    const raw = await pingQwenTokenWithRetry('tok', {
        pingFn: () => { calls += 1; return Promise.resolve('OK'); },
        retryCount: 3,
        retryDelayMs: 1
    });
    assert.equal(raw, 'OK');
    assert.equal(calls, 1);
});

test('pingQwenTokenWithRetry: UNAUTHORIZED/RATELIMIT финальны и не ретраятся', async () => {
    let calls = 0;
    const unauthorized = await pingQwenTokenWithRetry('tok', {
        pingFn: () => { calls += 1; return Promise.resolve('UNAUTHORIZED'); },
        retryCount: 3,
        retryDelayMs: 1
    });
    assert.equal(unauthorized, 'UNAUTHORIZED');
    assert.equal(calls, 1);

    const ratelimit = await pingQwenTokenWithRetry('tok', {
        pingFn: () => { calls += 1; return Promise.resolve('RATELIMIT'); },
        retryCount: 3,
        retryDelayMs: 1
    });
    assert.equal(ratelimit, 'RATELIMIT');
    assert.equal(calls, 2);
});

test('pingQwenTokenWithRetry: ERROR ретраится до успеха', async () => {
    const sequence = ['ERROR', 'ERROR', 'OK'];
    let calls = 0;
    const raw = await pingQwenTokenWithRetry('tok', {
        pingFn: () => Promise.resolve(sequence[calls++]),
        retryCount: 3,
        retryDelayMs: 1
    });
    assert.equal(raw, 'OK');
    assert.equal(calls, 3);
});

test('pingQwenTokenWithRetry: исчерпание retry возвращает ERROR', async () => {
    let calls = 0;
    const raw = await pingQwenTokenWithRetry('tok', {
        pingFn: () => { calls += 1; return Promise.resolve('ERROR'); },
        retryCount: 2,
        retryDelayMs: 1
    });
    assert.equal(raw, 'ERROR');
    assert.equal(calls, 3); // 1 + 2 retry
});

test('pingQwenTokenWithRetry: исключение из ping трактуется как ERROR и ретраится', async () => {
    let calls = 0;
    const raw = await pingQwenTokenWithRetry('tok', {
        pingFn: () => { calls += 1; if (calls === 1) return Promise.reject(new Error('boom')); return Promise.resolve('OK'); },
        retryCount: 2,
        retryDelayMs: 1
    });
    assert.equal(raw, 'OK');
    assert.equal(calls, 2);
});

// ─── buildQwenRequestHeaders ─────────────────────────────────────────────────

test('buildQwenRequestHeaders: заголовки Qwen с Bearer-токеном', () => {
    const headers = buildQwenRequestHeaders('tok', () => 'req-1');
    assert.equal(headers.Authorization, 'Bearer tok');
    assert.equal(headers['X-Request-Id'], 'req-1');
    assert.equal(headers.source, 'web');
    assert.equal(headers['Content-Type'], 'application/json');
});

test('buildQwenRequestHeaders: без токена заголовок Authorization отсутствует', () => {
    const headers = buildQwenRequestHeaders(null, () => 'req-1');
    assert.equal('Authorization' in headers, false);
});
