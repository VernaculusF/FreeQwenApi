import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildStatelessTranscript, stringifyOpenAIContent, FOLD_MAX_CHARS } from '../src/utils/statelessTranscript.js';

test('buildStatelessTranscript skips system messages and preserves order', () => {
    const out = buildStatelessTranscript([
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' }
    ], 10_000);
    assert.ok(out.startsWith('User: first'));
    assert.ok(out.includes('Assistant: reply'));
    assert.ok(out.endsWith('User: second'));
    assert.ok(!out.includes('You are a bot.'));
});

test('buildStatelessTranscript formats tool calls and tool results', () => {
    const out = buildStatelessTranscript([
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }
    ], 10_000);
    assert.ok(out.includes('Assistant tool calls:'));
    assert.ok(out.includes('Tool result (c1):'));
});

test('buildStatelessTranscript caps total size as a tail window', () => {
    const long = 'x'.repeat(500);
    const messages = [];
    for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `${i}:${long}` });
    }
    const max = 1500;
    const out = buildStatelessTranscript(messages, max);
    assert.ok(out.length <= max + 200, `got ${out.length} chars for cap ${max}`);
    // Tail kept: the last message must be present.
    assert.ok(out.includes('19:' + long));
    // Earlier messages omitted with a marker.
    assert.ok(/earlier message\(s\) omitted/.test(out));
    // Order preserved: last user message is at the end.
    assert.ok(out.endsWith('User: 19:' + long));
});

test('buildStatelessTranscript truncates a single over-long message to the cap', () => {
    const out = buildStatelessTranscript([
        { role: 'user', content: 'y'.repeat(50_000) }
    ], 1000);
    assert.ok(out.length <= 1000 + 200);
    assert.ok(out.startsWith('User: '));
    assert.ok(out.endsWith('y'));
});

test('buildStatelessTranscript returns empty string for empty input', () => {
    assert.equal(buildStatelessTranscript([], 1000), '');
    assert.equal(buildStatelessTranscript(null, 1000), '');
});

test('stringifyOpenAIContent handles text/image/file content arrays', () => {
    assert.equal(stringifyOpenAIContent('plain'), 'plain');
    const out = stringifyOpenAIContent([
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'http://x/img.png' } },
        { type: 'file', name: 'a.txt' }
    ]);
    assert.ok(out.includes('hello'));
    assert.ok(out.includes('[image: http://x/img.png]'));
    assert.ok(out.includes('[file: a.txt]'));
});

test('FOLD_MAX_CHARS has a sane default', () => {
    assert.equal(typeof FOLD_MAX_CHARS, 'number');
    assert.ok(FOLD_MAX_CHARS > 0);
});
