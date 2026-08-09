// operationGuard.js — универсальная обёртка для операций, которые могут «зависнуть».
//
// Рейсит исходный промис с таймаутом и AbortSignal клиента. При таймауте или
// отмене вызывает onAbort (обычно — уничтожение страницы из пула) и отклоняет
// промис, чтобы ресурс (страница браузера) не держался впустую.

/**
 * @param {Promise} promise
 * @param {object} [options]
 * @param {number|null} [options.timeoutMs]
 * @param {AbortSignal|null} [options.signal]
 * @param {string} [options.label]
 * @param {Function|null} [options.onAbort]
 * @returns {Promise}
 */
export function withOperationGuard(promise, { timeoutMs = null, signal = null, label = 'Операция', onAbort = null } = {}) {
    if (!timeoutMs && !signal) return promise;

    let timer = null;
    let abortListener = null;
    let settled = false;
    let timedOutOrAborted = false;

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (signal && abortListener) signal.removeEventListener('abort', abortListener);
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };
        const succeed = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        if (timeoutMs) {
            timer = setTimeout(() => {
                timedOutOrAborted = true;
                fail(Object.assign(new Error(`${label}: превышен таймаут (${timeoutMs}мс)`), { code: 'ETIMEDOUT' }));
            }, timeoutMs);
        }
        if (signal) {
            abortListener = () => {
                timedOutOrAborted = true;
                fail(Object.assign(new Error(`${label}: запрос отменён клиентом`), { code: 'ABORTED' }));
            };
            if (signal.aborted) {
                timedOutOrAborted = true;
                fail(Object.assign(new Error(`${label}: запрос отменён клиентом`), { code: 'ABORTED' }));
            } else {
                signal.addEventListener('abort', abortListener, { once: true });
            }
        }

        promise.then(succeed, fail);
    }).catch((err) => {
        if (timedOutOrAborted && typeof onAbort === 'function') onAbort();
        throw err;
    });
}
