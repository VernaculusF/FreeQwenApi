// cleanup.js — фоновая очистка данных по TTL (24/7 без ручного вмешательства).
//
// Периодически (CLEANUP_INTERVAL_MS) удаляет:
//   - session/history/*.json старше HISTORY_TTL_MS (через deleteChatsAutomatically);
//   - файлы uploads/ старше UPLOADS_TTL_MS (мултер-тайники, оставшиеся после
//     обрывов/ошибок загрузки — успешные сразу удаляются в routes.js).
//
// 0 в TTL отключает соответствующую часть; 0 в CLEANUP_INTERVAL_MS отключает
// очистку целиком. Таймеры unref'нуты: очистка никогда не держит процесс живым.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logWarn } from '../logger/index.js';
import { deleteChatsAutomatically } from './chatHistory.js';
import {
    UPLOADS_DIR,
    HISTORY_TTL_MS,
    UPLOADS_TTL_MS,
    CLEANUP_INTERVAL_MS,
    CLEANUP_INITIAL_DELAY_MS
} from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_PATH = path.resolve(__dirname, '..', '..', UPLOADS_DIR);

let timer = null;
let initialTimer = null;
let running = false;

export function isCleanupEnabled() {
    return CLEANUP_INTERVAL_MS > 0 && (HISTORY_TTL_MS > 0 || UPLOADS_TTL_MS > 0);
}

/**
 * Удаляет файлы в uploadsDir, изменённые раньше cutoff = now - ttlMs.
 * Синхронная, безопасная: несуществующая директория и ошибки отдельных файлов
 * не прерывают обход. Возвращает { checked, deleted }.
 */
export function cleanUploadsOlderThan(ttlMs, uploadsDir = UPLOADS_PATH) {
    if (!(ttlMs > 0) || !fs.existsSync(uploadsDir)) {
        return { checked: 0, deleted: 0 };
    }
    const cutoff = Date.now() - ttlMs;
    let checked = 0;
    let deleted = 0;
    for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        checked++;
        const filePath = path.join(uploadsDir, entry.name);
        try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        } catch (error) {
            logWarn(`Очистка uploads: не удалось обработать ${entry.name}: ${error.message}`);
        }
    }
    return { checked, deleted };
}

/**
 * Один прогон очистки. Зависимости можно подменить в тестах.
 * Возвращает сводку; { skipped: true } — если предыдущий прогон ещё идёт.
 */
export async function runCleanup({
    deleteChats = deleteChatsAutomatically,
    cleanUploads = cleanUploadsOlderThan,
    historyTtlMs = HISTORY_TTL_MS,
    uploadsTtlMs = UPLOADS_TTL_MS
} = {}) {
    if (running) return { skipped: true };

    running = true;
    try {
        const result = {};
        if (historyTtlMs > 0) {
            const r = await deleteChats({ olderThan: historyTtlMs });
            result.history = { success: r?.success === true, deletedCount: r?.deletedCount ?? 0 };
        }
        if (uploadsTtlMs > 0) {
            result.uploads = await cleanUploads(uploadsTtlMs);
        }
        logInfo(`Очистка по TTL: история — ${JSON.stringify(result.history ?? { пропущено: true })}, uploads — ${JSON.stringify(result.uploads ?? { пропущено: true })}`);
        return result;
    } finally {
        running = false;
    }
}

export function startCleanup() {
    if (!isCleanupEnabled() || timer || initialTimer) return;
    logInfo(`Фоновая очистка запущена: первый прогон через ${Math.round(CLEANUP_INITIAL_DELAY_MS / 1000)}с, далее каждые ${Math.round(CLEANUP_INTERVAL_MS / 1000)}с.`);

    initialTimer = setTimeout(() => {
        initialTimer = null;
        runCleanup().catch(e => logWarn(`Очистка: ошибка прогона: ${e.message}`));
        timer = setInterval(() => {
            runCleanup().catch(e => logWarn(`Очистка: ошибка прогона: ${e.message}`));
        }, CLEANUP_INTERVAL_MS);
        if (timer.unref) timer.unref();
    }, CLEANUP_INITIAL_DELAY_MS);
    if (initialTimer.unref) initialTimer.unref();
}

export function stopCleanup() {
    if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
    }
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
