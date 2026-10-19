// Servidor falso compatible con OpenAI (/v1) y Ollama (/api) que responde según un guion.
import http from 'node:http';
import zlib from 'node:zlib';

// script: [{ content, reasoning, toolCalls: [{ name, args }], error: { status, body } }]
export function startMockLLM({ script = [], models = ['mock-coder:7b', 'mock-small:1b'] } = {}) {
  const requests = [];
  const queue = [...script];
  const api = { rejectGzip: false };
  const server = http.createServer(async (req, res) => {
    // una conexión por petición: en Windows, reutilizar una conexión que otra prueba cortó da ECONNRESET
    res.setHeader('Connection', 'close');
    const parts = [];
    for await (const ch of req) parts.push(ch);
    let buf = Buffer.concat(parts);
    const gzipped = /gzip/.test(req.headers['content-encoding'] || '');
    // mock.rejectGzip = true imita a un servidor que no acepta cuerpos comprimidos
    if (gzipped && api.rejectGzip) { requests.push({ method: req.method, url: req.url, headers: req.headers, body: null, rejected: true }); res.writeHead(415); return res.end('unsupported content-encoding'); }
    if (gzipped) buf = zlib.gunzipSync(buf);
    const raw = buf.toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body, bytes: parts.reduce((n, c) => n + c.length, 0) });
    // mock.requireKey = 'clave' imita a llama-server con --api-key
    if (api.requireKey && req.headers.authorization !== `Bearer ${api.requireKey}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"Invalid API Key"}}'); }

    if (req.url === '/v1/models') return json(res, { data: models.map((id) => ({ id })) });
    if (req.url === '/api/tags') return json(res, { models: models.map((name) => ({ name, size: 1e9 })) });
    if (req.url !== '/v1/chat/completions' && req.url !== '/api/chat') { res.writeHead(404); return res.end('not found'); }

    const step = queue.shift() || { content: 'Listo.' };
    if (step.error) { res.writeHead(step.error.status); return res.end(step.error.body || 'error'); }
    const calls = (step.toolCalls || []).map((t, i) => ({ id: `call_${i}`, name: t.name, args: t.args || {} }));

    if (req.url === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (step.reasoning) res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', thinking: step.reasoning }, done: false })}\n`);
      for (const piece of chunks(step.content || '')) res.write(`${JSON.stringify({ message: { role: 'assistant', content: piece }, done: false })}\n`);
      if (calls.length) res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) }, done: false })}\n`);
      res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 20, eval_duration: 1e9 })}\n`);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (step.reasoning) send({ choices: [{ index: 0, delta: { reasoning_content: step.reasoning } }] });
    for (const piece of chunks(step.content || '')) {
      send({ choices: [{ index: 0, delta: { content: piece } }] });
      if (step.delay) await new Promise((r) => setTimeout(r, step.delay)); // streaming lento para probar la animación
    }
    calls.forEach((c, i) => {
      const args = JSON.stringify(c.args);
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(0, Math.ceil(args.length / 2)) } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(Math.ceil(args.length / 2)) } }] } }] });
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    res.end('data: [DONE]\n\n');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(Object.assign(api, {
        url: `http://127.0.0.1:${port}`,
        requests,
        push: (...steps) => queue.push(...steps),
        close: () => new Promise((r) => server.close(r)),
      }));
    });
  });
}

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function* chunks(s, n = 7) {
  for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n);
}
