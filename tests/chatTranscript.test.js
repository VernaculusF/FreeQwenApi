import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatTranscriptStore, messageKey, sequenceKeys } from '../src/api/chatTranscript.js';

const u = (content) => ({ role: 'user', content });
const a = (content) => ({ role: 'assistant', content });

test('messageKey: tool-call ходы нормализуются в маркер', () => {
  // Qwen-обёртка
  assert.equal(messageKey({ role: 'assistant', content: '{"tool_calls":[]}' }), 'assistant:[tool]');
  assert.equal(messageKey({ role: 'assistant', content: '{"tool_calls":[{"id":"x"}]}' }), 'assistant:[tool]');
  // Пустой content с tool_calls (как шлёт OpenCode)
  assert.equal(messageKey({ role: 'assistant', content: '' }), 'assistant:[tool]');
  // Обычный текст — не маркер
  assert.notEqual(messageKey(a('Привет')), 'assistant:[tool]');
  // Разные тексты — разные ключи
  assert.notEqual(messageKey(a('Привет')), messageKey(a('Пока')));
  assert.notEqual(messageKey(u('Привет')), messageKey(a('Привет')));
});

test('одна сессия: продолжение переиспользуется', () => {
  const store = createChatTranscriptStore();
  const base = 'chat_base';

  // Ход 1: новая сессия → fork
  const k1 = sequenceKeys([u('Запомни позывной')]);
  const id1 = store.fork(base, k1, [u('Запомни позывной')]);
  assert.equal(id1, `${base}::f1`);
  store.appendAssistant(id1, 'Понял, позывной КРАСНЫЙ.');

  // Ход 2: продолжение (история растёт) → та же беседа
  const k2 = sequenceKeys([u('Запомни позывной'), a('Понял, позывной КРАСНЫЙ.'), u('Какой мой позывной?')]);
  const cont = store.findContinuation(base, k2);
  assert.equal(cont, id1);
  store.appendDiff(cont, k2, [u('Запомни позывной'), a('Понял, позывной КРАСНЫЙ.'), u('Какой мой позывной?')]);
  store.appendAssistant(cont, 'КРАСНЫЙ.');

  const k3 = sequenceKeys([u('Запомни позывной'), a('Понял, позывной КРАСНЫЙ.'), u('Какой мой позывной?'), a('КРАСНЫЙ.'), u('Повтори')]);
  assert.equal(store.findContinuation(base, k3), id1);
});

test('две сессии с одинаковым первым сообщением не смешиваются', () => {
  const store = createChatTranscriptStore();
  const base = 'chat_hello';

  // Сессия A: «Привет» → ответ → продолжение
  const kA1 = sequenceKeys([u('Привет')]);
  const idA = store.fork(base, kA1, [u('Привет')]);
  store.appendAssistant(idA, 'Дарова! Чем помочь?');

  const kA2 = sequenceKeys([u('Привет'), a('Дарова! Чем помочь?'), u('Расскажи про себя')]);
  assert.equal(store.findContinuation(base, kA2), idA);

  // Сессия B: снова «Привет» → НЕ продолжение A (короче) → новый fork
  const kB1 = sequenceKeys([u('Привет')]);
  const idB = store.fork(base, kB1, [u('Привет')]);
  assert.notEqual(idB, idA);
  store.appendAssistant(idB, 'Привет! Чем могу помочь?');

  // Продолжение B: с тем же вторым вопросом, что и у A, но с другим ответом A1 — не смешивается
  const kB2 = sequenceKeys([u('Привет'), a('Привет! Чем могу помочь?'), u('Расскажи про себя')]);
  assert.equal(store.findContinuation(base, kB2), idB);
  // А продолжение A находит свою беседу
  const kA3 = sequenceKeys([u('Привет'), a('Дарова! Чем помочь?'), u('Расскажи про себя'), a('Я ИИ'), u('Ещё')]);
  assert.equal(store.findContinuation(base, kA3), idA);
});

test('ретрай того же хода (без ответа) — переиспользуется', () => {
  const store = createChatTranscriptStore();
  const base = 'chat_retry';
  const k1 = sequenceKeys([u('Привет')]);
  const id1 = store.fork(base, k1, [u('Привет')]);
  // ответ не пришёл (ошибка) — транскрипт без assistant
  assert.equal(store.findContinuation(base, sequenceKeys([u('Привет')])), id1);
});

test('оконный fold: хвост сохраняется, размер ограничен', () => {
  const store = createChatTranscriptStore();
  const base = 'chat_fold';
  const msgs = [u('Первый'), a('Ответ один'), u('Второй'), a('Ответ два')];
  const id = store.fork(base, sequenceKeys(msgs), msgs);
  const fold = store.buildWindowedTranscript(id, { maxChars: 1000 });
  assert.ok(fold.includes('Ответ два'));
  assert.ok(fold.includes('Первый'));

  // Жёсткий лимит: обрезается, но хвост цел
  const tiny = store.buildWindowedTranscript(id, { maxChars: 20 });
  assert.ok(tiny.includes('Ответ два'));
  assert.ok(tiny.length <= 20);

  // Пустой стор → null
  assert.equal(store.buildWindowedTranscript('chat_none'), null);
});

test('appendDiff дописывает только новые сообщения', () => {
  const store = createChatTranscriptStore();
  const base = 'chat_diff';
  const id = store.fork(base, sequenceKeys([u('А')]), [u('А')]);
  store.appendAssistant(id, 'Б');
  const k2 = sequenceKeys([u('А'), a('Б'), u('В')]);
  store.appendDiff(id, k2, [u('А'), a('Б'), u('В')]);
  const fold = store.buildWindowedTranscript(id);
  assert.ok(fold.includes('В'));
  // «А» и «Б» не задвоились
  assert.equal(fold.match(/User: А/g).length, 1);
  assert.equal(fold.match(/Assistant: Б/g).length, 1);
});

test('tool-ходы в транскрипте не ломают непрерывность', () => {
  const store = createChatTranscriptStore();
  const base = 'chat_tools';
  const toolMsg = (id, result) => ({ role: 'tool', tool_call_id: id, content: result });

  // Запрос 1 (как шлёт OpenCode): только user. Qwen вернул tool-call обёртку.
  const k1 = sequenceKeys([u('Посмотри файл')]);
  const id = store.fork(base, k1, [u('Посмотри файл')]);
  store.appendAssistant(id, '{"tool_calls":[{"id":"call_1","name":"read_file"}]}');

  // Запрос 2: user + assistant(tool_calls) + tool(результат) + следующий user.
  const k2 = sequenceKeys([
    u('Посмотри файл'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
    toolMsg('call_1', 'файл: hello world'),
    u('Что там?')
  ]);
  assert.equal(store.findContinuation(base, k2), id);
  store.appendDiff(id, k2, [
    u('Посмотри файл'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
    toolMsg('call_1', 'файл: hello world'),
    u('Что там?')
  ]);
  store.appendAssistant(id, 'В файле написано hello world');

  // Запрос 3: полная история + новый user — всё ещё продолжение.
  const k3 = sequenceKeys([
    u('Посмотри файл'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
    toolMsg('call_1', 'файл: hello world'),
    u('Что там?'),
    a('В файле написано hello world'),
    u('Спасибо')
  ]);
  assert.equal(store.findContinuation(base, k3), id);
});
