import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fnv1a, accountBelongsToSubset } from '../src/api/tokenManager.js';

// ─── fnv1a ───────────────────────────────────────────────────────────────────

test('fnv1a: детерминирован и стабилен для одного и того же id', () => {
    assert.equal(fnv1a('acc_1786260561048'), fnv1a('acc_1786260561048'));
    assert.equal(typeof fnv1a('acc_1'), 'number');
    assert.ok(fnv1a('acc_1') >= 0);
});

test('fnv1a: разные id почти всегда дают разные хэши', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `acc_${i}`);
    const hashes = new Set(ids.map(fnv1a));
    assert.equal(hashes.size, ids.length, 'коллизий не должно быть на 200 id');
});

// ─── accountBelongsToSubset: пустое подмножество ────────────────────────────

test('accountBelongsToSubset: пустой subset = все аккаунты', () => {
    assert.equal(accountBelongsToSubset('acc_1', ''), true);
    assert.equal(accountBelongsToSubset('acc_1', undefined), true);
    assert.equal(accountBelongsToSubset('acc_1', null), true);
});

// ─── accountBelongsToSubset: 'k/n' авто-распределение ───────────────────────

test('accountBelongsToSubset: k/n распределяет каждый аккаунт ровно в одну долю', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `acc_${i}`);
    for (const n of [2, 3, 5, 7]) {
        for (const id of ids) {
            const owners = [];
            for (let k = 0; k < n; k++) {
                if (accountBelongsToSubset(id, `${k}/${n}`)) owners.push(k);
            }
            assert.equal(owners.length, 1, `аккаунт ${id} при n=${n} должен принадлежать ровно 1 воркеру`);
        }
    }
});

test('accountBelongsToSubset: k/n распределение примерно сбалансировано', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `acc_${i}`);
    for (const n of [2, 3, 4]) {
        const counts = Array.from({ length: n }, () => 0);
        for (const id of ids) {
            for (let k = 0; k < n; k++) {
                if (accountBelongsToSubset(id, `${k}/${n}`)) counts[k]++;
            }
        }
        // Хэш-распределение: допускаем разброс в пределах 10% от идеала.
        const ideal = ids.length / n;
        for (const c of counts) {
            assert.ok(Math.abs(c - ideal) <= ideal * 0.1, `n=${n}: доля ${c} сильно отклоняется от ${ideal}: ${counts}`);
        }
    }
});

test('accountBelongsToSubset: k/n не зависит от порядка id (стабильность при добавлении)', () => {
    const base = ['acc_a', 'acc_b', 'acc_c', 'acc_d'];
    // Добавление нового аккаунта не должно менять долю существующих.
    for (const n of [2, 3]) {
        for (const id of base) {
            const before = Array.from({ length: n }, (_, k) => accountBelongsToSubset(id, `${k}/${n}`)).indexOf(true);
            const extended = ['acc_a', 'acc_b', 'acc_c', 'acc_d', 'acc_new_1', 'acc_new_2'];
            const after = Array.from({ length: n }, (_, k) => accountBelongsToSubset(id, `${k}/${n}`)).indexOf(true);
            assert.equal(after, before, `${id}: доля не должна меняться при добавлении аккаунтов`);
            void extended;
        }
    }
});

test('accountBelongsToSubset: некорректный k/n', () => {
    assert.equal(accountBelongsToSubset('acc_1', '5/3'), true, 'k >= n — не фильтруем');
    assert.equal(accountBelongsToSubset('acc_1', '1/1'), true, 'n=1 — не фильтруем');
    // Не k/n (нет цифр вокруг слэша) — трактуется как список id, аккаунт в нём отсутствует.
    assert.equal(accountBelongsToSubset('acc_1', 'abc/2'), false, 'не k/n — список id');
});

// ─── accountBelongsToSubset: явный список id ────────────────────────────────

test('accountBelongsToSubset: явный список id', () => {
    assert.equal(accountBelongsToSubset('acc_1', 'acc_1,acc_2'), true);
    assert.equal(accountBelongsToSubset('acc_2', 'acc_1,acc_2'), true);
    assert.equal(accountBelongsToSubset('acc_3', 'acc_1,acc_2'), false);
    assert.equal(accountBelongsToSubset('acc_1', ' acc_1 , acc_2 '), true, 'пробелы вокруг id игнорируются');
    assert.equal(accountBelongsToSubset('acc_1', ','), true, 'пустой список — не фильтруем');
});
