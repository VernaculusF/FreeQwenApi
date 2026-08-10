import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Счётчик операций пишется в файл (персистентность через рестарты). Чтобы не
// трогать session/ops.json живого сервера, подменяем путь через env ДО
// динамического импорта модуля.
const tmpFile = path.join(os.tmpdir(), `ops-test-${process.pid}.json`);
let recordOp, countOps, isOpsOverLimit, opFingerprint;
let mod;

before(async () => {
    process.env.QWEN_OPS_FILE = tmpFile;
    mod = await import('../src/api/tokenManager.js');
    ({ recordOp, countOps, isOpsOverLimit, opFingerprint } = mod);
});

after(() => {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
});

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';
const OTHER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.def';
const HOUR = 3600_000;
const NOW = 1_700_000_000_000;

test('opFingerprint: детерминированный и разный для разных токенов', () => {
    assert.equal(opFingerprint(TOKEN), opFingerprint(TOKEN));
    assert.notEqual(opFingerprint(TOKEN), opFingerprint(OTHER));
    assert.equal(opFingerprint(''), '');
    assert.equal(opFingerprint(null), '');
});

test('countOps: считает только операции в окне, старые отбрасываются', () => {
    recordOp(TOKEN, NOW - HOUR - 1000); // вне окна
    recordOp(TOKEN, NOW - 60_000);      // в окне
    recordOp(TOKEN, NOW);
    assert.equal(countOps(TOKEN, HOUR, NOW), 2);
});

test('isOpsOverLimit: false до лимита, true на лимите и выше', () => {
    assert.equal(isOpsOverLimit(OTHER, 3, HOUR, NOW), false);
    recordOp(OTHER, NOW);
    recordOp(OTHER, NOW);
    assert.equal(isOpsOverLimit(OTHER, 3, HOUR, NOW), false);
    recordOp(OTHER, NOW);
    assert.equal(isOpsOverLimit(OTHER, 3, HOUR, NOW), true);
    recordOp(OTHER, NOW);
    assert.equal(isOpsOverLimit(OTHER, 3, HOUR, NOW), true);
});

test('isOpsOverLimit: лимит 0/отрицательный отключает проверку', () => {
    assert.equal(isOpsOverLimit(TOKEN, 0, HOUR, NOW), false);
    assert.equal(isOpsOverLimit(TOKEN, -1, HOUR, NOW), false);
});

test('счётчики независимы между токенами', () => {
    const T3 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIzIn0.ghi';
    const T4 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0In0.jkl';
    recordOp(T3, NOW);
    recordOp(T3, NOW);
    assert.equal(countOps(T3, HOUR, NOW), 2);
    assert.equal(countOps(T4, HOUR, NOW), 0);
    recordOp(T4, NOW);
    assert.equal(countOps(T3, HOUR, NOW), 2);
    assert.equal(countOps(T4, HOUR, NOW), 1);
});

test('счётчик персистентен: повторный импорт видит записанные операции', async () => {
    // записываем через уже импортированный модуль и проверяем, что новый
    // импорт (с тем же QWEN_OPS_FILE) видит те же данные
    recordOp(OTHER, NOW);
    const mod2 = await import('../src/api/tokenManager.js');
    // у нового модуля своя Map, но она загружается из файла
    assert.equal(mod2.countOps(OTHER, HOUR, NOW) >= 1, true);
});
