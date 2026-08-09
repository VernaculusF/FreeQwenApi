import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { cleanUploadsOlderThan, runCleanup, isCleanupEnabled } from '../src/api/cleanup.js';
import { deleteChatsAutomatically } from '../src/api/chatHistory.js';

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, name, mtimeMs = Date.now()) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, 'x');
    // utimesSync принимает секунды с эпохи как number (Date — только мс!).
    fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
    return filePath;
}

// ─── cleanUploadsOlderThan ───────────────────────────────────────────────────

test('cleanUploadsOlderThan: удаляет только файлы старше TTL', () => {
    const dir = makeTempDir('cleanup-uploads-');
    try {
        const now = Date.now();
        writeFile(dir, 'old.bin', now - 2 * 3600_000); // 2 часа назад
        writeFile(dir, 'fresh.bin', now - 60_000);     // 1 минуту назад

        const result = cleanUploadsOlderThan(3600_000, dir); // TTL 1 час

        assert.deepEqual(result, { checked: 2, deleted: 1 });
        assert.equal(fs.existsSync(path.join(dir, 'old.bin')), false);
        assert.equal(fs.existsSync(path.join(dir, 'fresh.bin')), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cleanUploadsOlderThan: игнорирует поддиректории', () => {
    const dir = makeTempDir('cleanup-uploads-');
    try {
        const now = Date.now();
        const sub = path.join(dir, 'nested');
        fs.mkdirSync(sub);
        writeFile(sub, 'old-in-sub.bin', now - 2 * 3600_000);

        const result = cleanUploadsOlderThan(3600_000, dir);

        assert.deepEqual(result, { checked: 0, deleted: 0 });
        assert.equal(fs.existsSync(path.join(sub, 'old-in-sub.bin')), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cleanUploadsOlderThan: несуществующая директория и TTL=0 — безопасный no-op', () => {
    assert.deepEqual(cleanUploadsOlderThan(3600_000, path.join(os.tmpdir(), 'no-such-dir-xyz')), { checked: 0, deleted: 0 });

    const dir = makeTempDir('cleanup-uploads-');
    try {
        writeFile(dir, 'a.bin', Date.now() - 10_000);
        assert.deepEqual(cleanUploadsOlderThan(0, dir), { checked: 0, deleted: 0 });
        assert.equal(fs.existsSync(path.join(dir, 'a.bin')), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ─── deleteChatsAutomatically (мёртвый код, теперь используется по TTL) ─────

function writeChat(dir, id, created) {
    const filePath = path.join(dir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ id, name: id, created, messages: [] }, null, 2));
    return filePath;
}

test('deleteChatsAutomatically({ olderThan }): удаляет старые чаты, свежие сохраняет (по created, не mtime)', () => {
    const dir = makeTempDir('cleanup-history-');
    try {
        const now = Date.now();
        writeChat(dir, 'chat-old-1', now - 2 * 3600_000); // 2 часа назад (> TTL 1 час)
        writeChat(dir, 'chat-fresh-1', now);

        // Старому файлу «освежаем» mtime — удаление должно опираться на created из JSON.
        fs.utimesSync(path.join(dir, 'chat-old-1.json'), Date.now() / 1000, Date.now() / 1000);

        const result = deleteChatsAutomatically({ olderThan: 3600_000 }, dir);

        assert.equal(result.success, true);
        assert.equal(result.deletedCount, 1);
        assert.deepEqual(result.deletedChats, ['chat-old-1']);
        assert.equal(fs.existsSync(path.join(dir, 'chat-old-1.json')), false);
        assert.equal(fs.existsSync(path.join(dir, 'chat-fresh-1.json')), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ─── runCleanup ──────────────────────────────────────────────────────────────

test('runCleanup: прогоняет историю и uploads с подменёнными зависимостями', async () => {
    const calls = [];
    const result = await runCleanup({
        historyTtlMs: 5_000,
        uploadsTtlMs: 3_000,
        deleteChats: (criteria) => {
            calls.push(['history', criteria]);
            return { success: true, deletedCount: 2, deletedChats: ['a', 'b'] };
        },
        cleanUploads: (ttl) => {
            calls.push(['uploads', ttl]);
            return { checked: 5, deleted: 1 };
        }
    });

    assert.deepEqual(calls, [
        ['history', { olderThan: 5_000 }],
        ['uploads', 3_000]
    ]);
    assert.deepEqual(result, {
        history: { success: true, deletedCount: 2 },
        uploads: { checked: 5, deleted: 1 }
    });
});

test('runCleanup: TTL=0 пропускает соответствующую часть', async () => {
    const result = await runCleanup({
        historyTtlMs: 0,
        uploadsTtlMs: 10_000,
        deleteChats: () => { throw new Error('не должен вызываться'); },
        cleanUploads: () => ({ checked: 0, deleted: 0 })
    });
    assert.equal('history' in result, false);
    assert.deepEqual(result.uploads, { checked: 0, deleted: 0 });
});

test('runCleanup: overlap-guard — повторный вызов во время прогона пропускается', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });

    const first = runCleanup({
        historyTtlMs: 1,
        uploadsTtlMs: 0,
        deleteChats: async () => { await gate; return { success: true, deletedCount: 0 }; },
        cleanUploads: () => ({ checked: 0, deleted: 0 })
    });

    const second = await runCleanup({
        historyTtlMs: 1,
        uploadsTtlMs: 0,
        deleteChats: () => ({ success: true, deletedCount: 0 }),
        cleanUploads: () => ({ checked: 0, deleted: 0 })
    });
    assert.deepEqual(second, { skipped: true });

    release();
    const firstResult = await first;
    assert.deepEqual(firstResult.history, { success: true, deletedCount: 0 });
});

test('isCleanupEnabled: включён при дефолтных TTL и интервале', () => {
    // Дефолты: HISTORY_TTL_MS=30д, UPLOADS_TTL_MS=24ч, CLEANUP_INTERVAL_MS=6ч.
    assert.equal(isCleanupEnabled(), true);
});
