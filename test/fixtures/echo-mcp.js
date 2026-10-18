// Servidor MCP mínimo por stdio para pruebas: herramientas "echo" y "add", y un prompt "saludo".
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'echo-mcp', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'echo', description: 'Devuelve el texto recibido', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
      { name: 'add', description: 'Suma dos números', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
    ] } });
  } else if (method === 'tools/call') {
    const { name, arguments: a } = params;
    if (name === 'echo') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `eco: ${a.text}` }] } });
    else if (name === 'add') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(a.a + a.b) }] } });
    else send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'herramienta desconocida' }], isError: true } });
  } else if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'saludo', description: 'Saluda a alguien', arguments: [{ name: 'nombre' }] }] } });
  } else if (method === 'prompts/get') {
    send({ jsonrpc: '2.0', id, result: { messages: [{ role: 'user', content: { type: 'text', text: `Saluda a ${params.arguments?.nombre || 'todos'}` } }] } });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'método no encontrado' } });
  }
});
