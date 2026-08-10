import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contextIdentity, resolveRequestBrowserContext } from '../src/api/chat.js';

test('contextIdentity: Puppeteer Page сводится к её BrowserContext (общий cookie-джар)', () => {
  const defaultCtx = { kind: 'default-context' };
  const fakePage = { browserContext: () => defaultCtx };
  assert.equal(contextIdentity(fakePage), defaultCtx);
});

test('contextIdentity: BrowserContext остаётся собой (изоляция аккаунтов)', () => {
  const accountCtxA = { kind: 'account-a' };
  const accountCtxB = { kind: 'account-b' };
  assert.equal(contextIdentity(accountCtxA), accountCtxA);
  assert.notEqual(contextIdentity(accountCtxA), accountCtxB);
});

test('contextIdentity: страницы разных контекстов не совпадают (страницу A нельзя отдавать B)', () => {
  const ctxA = { kind: 'acc-a' };
  const ctxB = { kind: 'acc-b' };
  const pageFromA = { browserContext: () => ctxA };
  const pageFromB = { browserContext: () => ctxB };
  assert.notEqual(contextIdentity(pageFromA), contextIdentity(pageFromB));
});

test('contextIdentity: пустые/непuppeteer объекты возвращаются как есть (тесты/моки)', () => {
  const plain = { name: 'mock' };
  assert.equal(contextIdentity(plain), plain);
  assert.equal(contextIdentity(null), null);
  assert.equal(contextIdentity(undefined), undefined);
});

test('resolveRequestBrowserContext: managed-аккаунт без браузера не падает и возвращает null', async () => {
  // Браузер в тесте не инициализирован: getAccountBrowserContext вернёт null,
  // и функция обязана не упасть, а вернуть null (как и getBrowserContext()).
  const ctx = await resolveRequestBrowserContext('managed:acc_123');
  assert.equal(ctx, null);
});

test('resolveRequestBrowserContext: browser-токен и мусор не трогают аккаунтные контексты', async () => {
  assert.equal(await resolveRequestBrowserContext('browser:fingerprint'), null);
  assert.equal(await resolveRequestBrowserContext(null), null);
  assert.equal(await resolveRequestBrowserContext(undefined), null);
});
