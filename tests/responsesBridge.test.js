import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
    createConversationAffinity,
    createResponsesBridge,
    extractConversationIdentity,
    responsesToChat
} from '../src/api/responsesBridge.js';

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
    return new Promise(resolve => server.close(resolve));
}

function sseResponse(response, text = 'ok') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
}

async function postResponse(port, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    return { status: response.status, text: await response.text() };
}

function streamedResponseId(events) {
    return JSON.parse(events.match(/data: (\{[^\n]+"response\.created"[^\n]+\})/)?.[1] || '{}').response?.id
        || events.match(/"id":"(resp_[^"]+)"/)?.[1]
        || null;
}

test('converts Codex Responses input and tools to Chat Completions', () => {
    const result = responsesToChat({
        model: 'qwen3.8-max',
        instructions: 'base',
        input: [
            { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'policy' }] },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
            { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' }
        ],
        tools: [{ type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object' } }]
    });

    assert.equal(result.model, 'qwen3.8-max');
    assert.deepEqual(result.messages.map(message => message.role), ['system', 'system', 'user', 'assistant', 'tool']);
    assert.equal(result.messages[3].tool_calls[0].function.name, 'exec_command');
    assert.equal(result.messages[4].tool_call_id, 'call_1');
    assert.equal(result.tools[0].function.name, 'exec_command');
    assert.equal(result.stream, true);
});

test('preserves image input for a multimodal Qwen model', () => {
    const result = responsesToChat({
        model: 'qwen3.8-max',
        input: [{
            type: 'message', role: 'user', content: [
                { type: 'input_text', text: 'inspect' },
                { type: 'input_image', image_url: 'data:image/png;base64,abc' }
            ]
        }]
    });

    assert.equal(result.messages[0].content[1].type, 'image_url');
    assert.equal(result.messages[0].content[1].image_url.url, 'data:image/png;base64,abc');
});

test('maps a resumed GPT thread to the Qwen default model', () => {
    const result = responsesToChat({ model: 'gpt-5.6-sol', input: 'continue' });
    assert.equal(result.model, 'qwen3.8-max');
});

test('extracts stable conversation identity from Codex request metadata', () => {
    assert.deepEqual(
        extractConversationIdentity({ client_metadata: { thread_id: 'thread-a' } }),
        { explicitId: 'thread-a', source: 'body.client_metadata', previousResponseId: null }
    );
    assert.deepEqual(
        extractConversationIdentity({}, {
            headers: { 'x-codex-turn-metadata': JSON.stringify({ conversation_id: 'thread-b' }) }
        }),
        { explicitId: 'thread-b', source: 'header.x-codex-turn-metadata', previousResponseId: null }
    );
});

test('uses the earliest retained turn metadata when Codex replays history', () => {
    const identity = extractConversationIdentity({
        input: [
            { type: 'message', internal_chat_message_metadata_passthrough: { turn_id: 'root-turn' } },
            { type: 'message', internal_chat_message_metadata_passthrough: { turn_id: 'latest-turn' } }
        ]
    });
    assert.equal(identity.explicitId, 'root-turn');
    assert.equal(identity.source, 'root_turn_id');
});

test('previous response keeps a conversation on its canonical affinity', () => {
    const affinity = createConversationAffinity({ upstreamCount: 2 });
    const first = affinity.resolve({ explicitId: 'thread-a' });
    assert.equal(affinity.bindResponse('resp_a', first.conversationId), true);

    const resumed = affinity.resolve({ explicitId: 'new-turn-id', previousResponseId: 'resp_a' });
    const stable = affinity.resolve({ explicitId: 'thread-a' });
    assert.equal(resumed.conversationId, first.conversationId);
    assert.equal(resumed.upstreamIndex, first.upstreamIndex);
    assert.equal(stable.conversationId, first.conversationId);
});

test('bridge sends a stable isolated conversation id to a sticky upstream', async () => {
    const captures = [[], []];
    const upstreams = captures.map((capture, index) => http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        capture.push({
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            headerConversation: request.headers['x-conversation-id']
        });
        sseResponse(response, `upstream-${index}`);
    }));
    const upstreamPorts = await Promise.all(upstreams.map(listen));
    const bridge = createResponsesBridge({
        upstreams: upstreamPorts.map(port => `http://127.0.0.1:${port}/chat/completions`)
    });
    const bridgePort = await listen(bridge);

    try {
        const first = await postResponse(bridgePort, {
            model: 'qwen3.8-max',
            client_metadata: { thread_id: 'thread-a' },
            input: 'first'
        });
        assert.equal(first.status, 200);
        const responseId = streamedResponseId(first.text);
        assert.ok(responseId);

        const second = await postResponse(bridgePort, {
            model: 'qwen3.8-max',
            client_metadata: { thread_id: 'thread-a' },
            previous_response_id: responseId,
            input: 'second'
        });
        assert.equal(second.status, 200);

        const third = await postResponse(bridgePort, {
            model: 'qwen3.8-max',
            client_metadata: { thread_id: 'thread-b' },
            input: 'other thread'
        });
        assert.equal(third.status, 200);

        const allCaptures = captures.flat();
        const threadA = allCaptures.filter(entry => ['first', 'second'].includes(entry.body.messages.at(-1)?.content));
        const threadB = allCaptures.find(entry => entry.body.messages.at(-1)?.content === 'other thread');
        assert.equal(threadA.length, 2);
        assert.equal(threadA[0].body.conversation_id, threadA[1].body.conversation_id);
        assert.equal(threadA[0].headerConversation, threadA[0].body.conversation_id);
        assert.notEqual(threadA[0].body.conversation_id, threadB.body.conversation_id);
        assert.ok(captures.some(capture => capture.length === 2), 'same thread must use one upstream');
    } finally {
        await close(bridge);
        await Promise.all(upstreams.map(close));
    }
});

test('does not duplicate a streamed tool name', async () => {
    const upstream = http.createServer((request, response) => {
        request.resume();
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\"printf ok\\"}"}}]}}]}\n\n');
        response.end('data: [DONE]\n\n');
    });
    const upstreamPort = await listen(upstream);
    const bridge = createResponsesBridge({ upstreams: [`http://127.0.0.1:${upstreamPort}/chat/completions`] });
    const bridgePort = await listen(bridge);

    try {
        const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'qwen3.8-max', input: 'run it', tools: [{ type: 'function', name: 'exec_command' }] })
        });
        const events = await response.text();
        assert.match(events, /"name":"exec_command"/);
        assert.doesNotMatch(events, /exec_commandexec_command/);
    } finally {
        await close(bridge);
        await close(upstream);
    }
});
