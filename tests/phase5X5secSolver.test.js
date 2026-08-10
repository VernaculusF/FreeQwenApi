import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPunishUrl, buildTrajectory, isX5secPage } from '../src/browser/x5secSolver.js';

test('extractPunishUrl: находит URL из window.location.replace', () => {
    const body = `<!DOCTYPE html><html><body><script>window.location.replace("https://chat.qwen.ai//api/v2/chat/completions/_____tmd_____/punish?x5secdata=xcv%2Fabc")</script></body></html>`;
    const url = extractPunishUrl(body);
    assert.ok(url, 'URL должен быть найден');
    assert.ok(url.includes('_____tmd_____'), 'URL должен содержать маркер челленджа');
    assert.ok(url.includes('punish'), 'URL должен указывать на punish');
});

test('extractPunishUrl: одиночные кавычки', () => {
    const body = `window.location.replace('https://chat.qwen.ai/punish?x5secdata=zzz')`;
    assert.equal(extractPunishUrl(body), 'https://chat.qwen.ai/punish?x5secdata=zzz');
});

test('extractPunishUrl: fallback на голый URL в тексте', () => {
    const body = 'some text https://chat.qwen.ai/_____tmd_____/punish?x5secdata=1 and more';
    const url = extractPunishUrl(body);
    assert.ok(url && url.includes('_____tmd_____'));
});

test('extractPunishUrl: нет челленджа — null', () => {
    assert.equal(extractPunishUrl('{"code":"RateLimited"}'), null);
    assert.equal(extractPunishUrl(null), null);
    assert.equal(extractPunishUrl(''), null);
});

test('extractPunishUrl: обычный JSON без редиректа — null', () => {
    const body = JSON.stringify({ success: true, data: { id: 'x' } });
    assert.equal(extractPunishUrl(body), null);
});

test('buildTrajectory: покрывает всю дистанцию и не выходит за края', () => {
    const pts = buildTrajectory(513, 771, 44);
    assert.ok(pts.length >= 44, 'достаточно точек');
    assert.ok(pts[0].x >= 513 - 2, 'старт в начале');
    assert.ok(Math.abs(pts[pts.length - 1].x - 771) <= 2, 'финиш в конце');
    // монотонность по x (не возвращаемся назад)
    for (let i = 1; i < pts.length; i++) {
        assert.ok(pts[i].x > pts[i - 1].x - 2, `точка ${i} не должна уезжать назад`);
    }
    // длительность трассы ~1с
    const total = pts.reduce((a, p) => a + p.delay, 0);
    assert.ok(total > 500 && total < 2500, `длительность ${total}мс в человеческом диапазоне`);
});

test('buildTrajectory: разные запуски дают разные траектории', () => {
    const a = buildTrajectory(0, 258);
    const b = buildTrajectory(0, 258);
    const same = a.every((p, i) => p.x === b[i].x && p.delay === b[i].delay);
    assert.ok(!same, 'траектории должны различаться (джиттер)');
});

test('isX5secPage: url-детект без браузера', async () => {
    // не можем вызвать с фейковым page — проверяем только экспорт функции
    assert.equal(typeof isX5secPage, 'function');
});
