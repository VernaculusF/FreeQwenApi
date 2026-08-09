// verificationMarkers.js — единый реестр маркеров верификации и анти-бот.
//
// Все потребители (детекция страницы в auth.js, классификация ping в
// qwenPing.js, разбор ответов chat в chat.js) используют одни и те же маркеры,
// чтобы WAF/капча распознавались одинаково во всех местах.
//
// Модуль чистый: не импортирует ничего из проекта — циклов нет.

// ─── Анти-бот WAF Alibaba: HTTP 200 + HTML-капча ─────────────────────────────
// Классический ответ на «подозрительный» запрос: страница с редиректом на
// _____tmd_____/punish, x5sec-данные или JSON-конфиг капчи. Плюс любые сырые
// HTML-ответы (<!doctype html) на JSON-эндпоинтах считаются WAF/шлюзом.
export const WAF_HTML_MARKER_RE = /_____tmd_____|x5sec|\/punish|"action"\s*:\s*"captcha"/i;
const HTML_PREFIX_RE = /^<!doctype html|^<html/i;

export function isWafHtmlBlock(text) {
    const body = String(text || '');
    return WAF_HTML_MARKER_RE.test(body) || HTML_PREFIX_RE.test(body.trim());
}

// ─── Маркеры анти-бот в теле ответа API (rgv587 и др.) ───────────────────────
export const ANTIBOT_BODY_MARKER_RE = /rgv587|fail_sys_user_validate|purecaptcha|_____tmd_____/i;

export function isAntiBotBody(text) {
    const lower = String(text || '').toLowerCase();
    return ANTIBOT_BODY_MARKER_RE.test(lower)
        || (lower.includes('window._config_') && lower.includes('captcha'));
}

// ─── Детекция страницы верификации ───────────────────────────────────────────

// Паттерны URL/заголовка, указывающие на верификацию/капчу/анти-бот.
export const VERIFICATION_URL_RE = /(verification|verify|captcha|challenge|punish|safety[-_]?check|security[-_]?check|antibot|anti[-_]?bot|human)/i;

// Фразы в тексте страницы. Осознанно не берём одиночные слова вроде
// «проверка»/«verify» — они встречаются в обычном UI; только фразы/спецсимволы,
// характерные для страниц верификации (специфичные WAF-маркеры x5sec/_____tmd_____
// покрываются isWafHtmlBlock, поэтому здесь их нет).
export const VERIFICATION_TEXT_MARKERS = [
    'verification',
    'verify you are human',
    'human verification',
    'security verification',
    'please verify',
    'complete the verification',
    'подтвердите, что вы не робот',
    'подтвердите, что вы человек',
    'пройдите проверку',
    'введите символы',
    '人机验证',
    '验证码',
    'captcha'
];

export function isVerificationText(text) {
    const body = String(text || '').toLowerCase();
    return VERIFICATION_TEXT_MARKERS.some(marker => body.includes(marker.toLowerCase()));
}
