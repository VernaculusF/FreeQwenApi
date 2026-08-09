import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseTokenInput,
    buildImportPlan,
    isJwtLikeToken,
    sanitizeAccountId,
    DEFAULT_ACCOUNT_PREFIX
} from '../src/utils/tokenImport.js';

const T1 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';
const T2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.def';
const T3 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIzIn0.ghi';

test('isJwtLikeToken: JWT принимается, мусор — нет', () => {
    assert.equal(isJwtLikeToken(T1), true);
    assert.equal(isJwtLikeToken('  ' + T1 + '  '), true);
    assert.equal(isJwtLikeToken('not-a-jwt'), false);
    assert.equal(isJwtLikeToken(''), false);
    assert.equal(isJwtLikeToken(null), false);
    assert.equal(isJwtLikeToken('eyJabc'), false);
});

test('sanitizeAccountId: чистит небезопасные символы', () => {
    assert.equal(sanitizeAccountId('alice'), 'alice');
    assert.equal(sanitizeAccountId('alice smith!'), 'alice_smith_');
    assert.equal(sanitizeAccountId(''), null);
    assert.equal(sanitizeAccountId(null, 'fallback'), 'fallback');
});

test('parseTokenInput: строки, комментарии, пустые строки', () => {
    const items = parseTokenInput(`# header
${T1}

  ${T2}  
# another
`);
    assert.deepEqual(items.map(i => i.token), [T1, T2]);
});

test('parseTokenInput: именованные аккаунты id=token и id: token', () => {
    const items = parseTokenInput(`alice=${T1}
bob: ${T2}`);
    assert.deepEqual(items, [
        { token: T1, id: 'alice' },
        { token: T2, id: 'bob' }
    ]);
});

test('parseTokenInput: JSON-массив строк и объектов', () => {
    const strings = parseTokenInput(JSON.stringify([T1, T2]));
    assert.deepEqual(strings.map(i => i.token), [T1, T2]);

    const objects = parseTokenInput(JSON.stringify([
        { token: T1, id: 'alice' },
        { token: T2 }
    ]));
    assert.deepEqual(objects, [
        { token: T1, id: 'alice' },
        { token: T2 }
    ]);
});

test('parseTokenInput: пустой и не-JSON мусор', () => {
    assert.deepEqual(parseTokenInput(''), []);
    assert.deepEqual(parseTokenInput('   \n\n'), []);
    // Строка, похожая на JSON, но не парсящаяся — уходит в построчный разбор.
    const items = parseTokenInput('{"token": ' + T1);
    assert.deepEqual(items.map(i => i.token), ['{"token": ' + T1]);
});

test('buildImportPlan: добавляет новые, пропускает дубликаты внутри батча', () => {
    const { toAdd, duplicates, skippedEmpty } = buildImportPlan(
        [],
        [
            { token: T1 },
            { token: T1 },
            { token: T2 },
            { token: '' }
        ],
        { now: 1000 }
    );
    assert.equal(duplicates, 1);
    assert.equal(skippedEmpty, 1);
    assert.deepEqual(toAdd.map(x => x.token), [T1, T2]);
});

test('buildImportPlan: пропускает токены, уже существующие в tokens.json', () => {
    const existing = [{ id: 'acc_old', token: T1, resetAt: null }];
    const { toAdd, duplicates } = buildImportPlan(existing, [{ token: T1 }, { token: T3 }]);
    assert.equal(duplicates, 1);
    assert.deepEqual(toAdd.map(x => x.token), [T3]);
});

test('buildImportPlan: генерирует уникальные id с префиксом и сохраняет именованные', () => {
    const { toAdd } = buildImportPlan([], [{ token: T1, id: 'alice' }, { token: T2 }], { prefix: 'k_', now: 42 });
    assert.equal(toAdd[0].id, 'alice');
    assert.ok(toAdd[1].id.startsWith(`k_${(42).toString(36)}_`));
    assert.notEqual(toAdd[1].id, toAdd[0].id);
});

test('buildImportPlan: дефолтный префикс из константы', () => {
    const { toAdd } = buildImportPlan([], [{ token: T1 }], { now: 7 });
    assert.ok(toAdd[0].id.startsWith(DEFAULT_ACCOUNT_PREFIX));
});
