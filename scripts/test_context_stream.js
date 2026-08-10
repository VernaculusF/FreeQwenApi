// Live check: context persistence + streaming (no tools; feed real assistant replies back)
const BASE = process.env.BASE || 'http://127.0.0.1:3264/api';
const KEY = process.env.KEY || '';
if (!KEY) { console.error('Set KEY=<api key> to run this live test.'); process.exit(2); }

async function streamTurn(messages) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'qwen3.8-max', messages, stream: true }),
    signal: AbortSignal.timeout(150000)
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', chunks = 0, text = '', toolCalls = 0, error = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const choice = obj.choices?.[0] || {};
        const delta = choice.delta || {};
        if (delta.content) { chunks++; text += delta.content; }
        if (delta.tool_calls) toolCalls++;
        if (choice.finish_reason === 'error') error = 'finish_reason=error';
      } catch { /* partial */ }
    }
  }
  return { chunks, text: text.trim(), toolCalls, error, ms: Date.now() - t0 };
}

(async () => {
  const history = [];
  const turns = [
    'Запомни: мой позывной — КРАСНЫЙ. Ответь одним словом "Понял."',
    'Какой у меня позывной? Ответь только позывным.',
    'Повтори позывной и скажи одним словом, помнишь ли ты мой первый вопрос.'
  ];
  for (let i = 0; i < turns.length; i++) {
    history.push({ role: 'user', content: turns[i] });
    const r = await streamTurn(history);
    console.log(`--- turn ${i + 1}: ${r.ms}ms, chunks=${r.chunks}, toolCalls=${r.toolCalls}, err="${r.error}"`);
    console.log(`    answer: ${r.text.slice(0, 160)}`);
    if (!r.text && !r.toolCalls) { console.log('    (пустой ответ — см. серверный лог)'); }
    history.push({ role: 'assistant', content: r.text || '(no text)' });
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
