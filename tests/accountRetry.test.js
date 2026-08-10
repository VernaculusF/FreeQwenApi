import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAccountSwitchRetryArgs,
  retryAfterAccountSwitch,
  retryAfterChallengeSolve
} from '../src/api/chat.js';

test('account-switch retry resets Qwen chat ownership and preserves agent context', async () => {
  const files = [{ id: 'file-1' }];
  const tools = [{ type: 'function', function: { name: 'read_file' } }];
  const toolChoice = { type: 'function', function: { name: 'read_file' } };
  const systemMessage = 'Use the requested tool and return its result.';
  const onChunk = () => {};
  const resetMessage = 'User: Read the file';
  const clientScope = 'proxy-client-scope-a';
  const requestContext = {
    message: 'Read the file',
    model: 'qwen3.7-max',
    chatId: 'chat-owned-by-old-account',
    parentId: 'parent-owned-by-old-account',
    files,
    tools,
    toolChoice,
    systemMessage,
    chatType: 't2t',
    size: null,
    waitForCompletion: true,
    retryCount: 2,
    onChunk,
    resetMessage,
    clientScope
  };

  let receivedArgs;
  const expectedResult = { ok: true };
  const result = await retryAfterAccountSwitch(requestContext, (...args) => {
    receivedArgs = args;
    return expectedResult;
  });

  assert.equal(result, expectedResult);
  assert.deepEqual(receivedArgs, [
    'Read the file',
    'qwen3.7-max',
    null,
    null,
    files,
    tools,
    toolChoice,
    systemMessage,
    't2t',
    null,
    true,
    3,
    onChunk,
    resetMessage,
    clientScope,
    null,
    false
  ]);
});

test('account-switch retry helper preserves forceBrowserFetch', async () => {
  let receivedArgs;
  await retryAfterAccountSwitch({ message: 'hello', model: 'qwen3.7-max', forceBrowserFetch: true }, (...args) => {
    receivedArgs = args;
  });
  assert.equal(receivedArgs[16], true);
});

test('account-switch retry helper uses safe sendMessage defaults', () => {
  assert.deepEqual(buildAccountSwitchRetryArgs({ message: 'hello', model: 'qwen3.7-max' }), [
    'hello',
    'qwen3.7-max',
    null,
    null,
    null,
    null,
    null,
    null,
    't2t',
    null,
    true,
    1,
    null,
    null,
    null,
    null,
    false
  ]);
});

test('retry-after-challenge-solve keeps chat ownership and forces browser fetch', async () => {
  let receivedArgs;
  const requestContext = {
    message: 'hello',
    model: 'qwen3.7-max',
    chatId: 'chat-xyz',
    parentId: 'parent-xyz',
    retryCount: 1
  };
  await retryAfterChallengeSolve(requestContext, (...args) => {
    receivedArgs = args;
  });
  assert.equal(receivedArgs[2], 'chat-xyz', 'chatId сохраняется');
  assert.equal(receivedArgs[3], 'parent-xyz', 'parentId сохраняется');
  assert.equal(receivedArgs[11], 2, 'retryCount увеличивается');
  assert.equal(receivedArgs[16], true, 'forceBrowserFetch включён');
});

test('account-switch retry rejects a missing sendMessage implementation', async () => {
  await assert.rejects(
    retryAfterAccountSwitch({ message: 'hello' }, null),
    /sendMessageFn must be a function/
  );
});
