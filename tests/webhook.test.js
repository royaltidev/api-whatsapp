const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { validarUrlWebhook, assinar, entregarWebhook, enderecoInterno } = require('../lib/webhook');
const { extrairMensagemRecebida } = require('../lib/mensagem-recebida');

function servidorReceptor(respostas) {
  const recebidas = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (parte) => { corpo += parte; });
    req.on('end', () => {
      recebidas.push({ headers: req.headers, corpo });
      res.statusCode = respostas[Math.min(recebidas.length - 1, respostas.length - 1)];
      res.end();
    });
  });
  return new Promise((resolver) => servidor.listen(0, '127.0.0.1', () => {
    resolver({ url: `http://127.0.0.1:${servidor.address().port}/webhook`, recebidas, fechar: () => { servidor.closeAllConnections(); servidor.close(); } });
  }));
}

test('validarUrlWebhook aceita HTTPS público e recusa destinos inseguros', () => {
  assert.equal(validarUrlWebhook('https://like.exemplo.com.br/api/whatsapp/webhook'), 'https://like.exemplo.com.br/api/whatsapp/webhook');
  for (const invalida of ['http://like.exemplo.com.br/x', 'https://u:s@like.exemplo.com.br/x', 'https://localhost/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://169.254.169.254/x', 'nao-e-url', '', null]) {
    assert.throws(() => validarUrlWebhook(invalida), (erro) => erro.statusCode === 400, String(invalida));
  }
  assert.equal(validarUrlWebhook('http://127.0.0.1:3000/x', { permitirLocal: true }), 'http://127.0.0.1:3000/x');
});

test('enderecoInterno cobre IPv4, IPv6 e IPv4 mapeado', () => {
  assert.equal(enderecoInterno('192.168.1.10'), true);
  assert.equal(enderecoInterno('::ffff:127.0.0.1'), true);
  assert.equal(enderecoInterno('fd00::1'), true);
  assert.equal(enderecoInterno('8.8.8.8'), false);
  assert.equal(enderecoInterno('2001:4860:4860::8888'), false);
});

test('entregarWebhook envia evento assinado e verificável', async () => {
  const receptor = await servidorReceptor([200]);
  try {
    const resultado = await entregarWebhook({ url: receptor.url, segredo: 'segredo-teste' }, 'mensagem_recebida', { telefone: '5577999990000' }, { permitirLocal: true });
    assert.deepEqual(resultado, { ok: true, tentativas: 1 });
    const [{ headers, corpo }] = receptor.recebidas;
    assert.equal(headers['x-webhook-evento'], 'mensagem_recebida');
    assert.equal(headers['x-webhook-assinatura'], `sha256=${assinar('segredo-teste', headers['x-webhook-timestamp'], corpo)}`);
    const json = JSON.parse(corpo);
    assert.equal(json.id, headers['x-webhook-id']);
    assert.deepEqual(json.dados, { telefone: '5577999990000' });
  } finally { receptor.fechar(); }
});

test('entregarWebhook reenvia após erro 5xx e desiste em 4xx', async () => {
  const instavel = await servidorReceptor([500, 503, 200]);
  try {
    const resultado = await entregarWebhook({ url: instavel.url, segredo: 's' }, 'mensagem_recebida', {}, { permitirLocal: true, atrasosMs: [5, 5, 5] });
    assert.deepEqual(resultado, { ok: true, tentativas: 3 });
  } finally { instavel.fechar(); }

  const recusa = await servidorReceptor([401]);
  try {
    const resultado = await entregarWebhook({ url: recusa.url, segredo: 's' }, 'mensagem_recebida', {}, { permitirLocal: true, atrasosMs: [5, 5, 5] });
    assert.equal(resultado.ok, false);
    assert.equal(resultado.tentativas, 1);
    assert.equal(recusa.recebidas.length, 1);
  } finally { recusa.fechar(); }
});

test('entregarWebhook não entrega quando o DNS aponta para a rede interna', async () => {
  let chamadas = 0;
  const resultado = await entregarWebhook({ url: 'https://like.exemplo.com.br/x', segredo: 's' }, 'mensagem_recebida', {}, {
    atrasosMs: [5],
    resolverDns: async () => [{ address: '10.1.2.3' }],
    fetchImpl: async () => { chamadas++; return { status: 200 }; },
  });
  assert.equal(resultado.ok, false);
  assert.match(resultado.erro, /rede interna/);
  assert.equal(chamadas, 0);
});

test('extrairMensagemRecebida trata contato, LID, grupos e mídia', async () => {
  const client = { getContactLidAndPhone: async () => [{ lid: '123@lid', pn: '5577988887777@c.us' }] };
  const base = { id: { _serialized: 'false_x_1' }, timestamp: 1790000000, type: 'chat', body: 'Pode sim' };

  assert.deepEqual(await extrairMensagemRecebida({ ...base, from: '5577999990000@c.us' }, client), {
    mensagem_id: 'false_x_1', telefone: '5577999990000', tipo: 'chat', texto: 'Pode sim',
    recebido_em: new Date(1790000000 * 1000).toISOString(),
  });
  assert.equal((await extrairMensagemRecebida({ ...base, from: '123@lid' }, client)).telefone, '5577988887777');
  assert.equal((await extrairMensagemRecebida({ ...base, from: '5577999990000@c.us', type: 'ptt', body: 'x' }, client)).texto, null);
  assert.equal(await extrairMensagemRecebida({ ...base, from: '1203630@g.us' }, client), null);
  assert.equal(await extrairMensagemRecebida({ ...base, from: 'status@broadcast', isStatus: true }, client), null);
  assert.equal(await extrairMensagemRecebida({ ...base, from: '5577999990000@c.us', fromMe: true }, client), null);
  assert.equal(await extrairMensagemRecebida({ ...base, from: '999@lid' }, { getContactLidAndPhone: async () => [{ lid: '999@lid' }] }), null);
});
