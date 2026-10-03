/**
 * Webhook de eventos por cliente (integração): avisa o software dono do token
 * quando algo acontece na sessão dele — hoje, só "mensagem_recebida".
 *
 * Cada entrega leva a assinatura HMAC-SHA256 de `${timestamp}.${corpo}` com o
 * segredo daquele cliente no header X-Webhook-Assinatura, para o receptor
 * conferir origem e integridade e recusar reenvios antigos pelo timestamp.
 *
 * Como a URL é informada pelo próprio cliente, o destino não pode apontar para
 * a rede interna da VPS (SSRF): exige HTTPS e recusa hosts que resolvem para
 * endereços privados/loopback — exceto com WHATSAPP_WEBHOOK_PERMITIR_LOCAL=true,
 * pensado só para testes em máquina de desenvolvimento.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_ENTREGA_MS = 5000;
const ATRASOS_REENVIO_MS = [2000, 10000, 30000];
const MAX_URL = 2048;

const redesBloqueadas = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4],
].forEach(([rede, prefixo]) => redesBloqueadas.addSubnet(rede, prefixo, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]
  .forEach(([rede, prefixo]) => redesBloqueadas.addSubnet(rede, prefixo, 'ipv6'));

function enderecoInterno(ip) {
  const mapeado = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapeado) return redesBloqueadas.check(mapeado[1], 'ipv4');
  const tipo = net.isIP(ip);
  if (!tipo) return true;
  return redesBloqueadas.check(ip, tipo === 4 ? 'ipv4' : 'ipv6');
}

function erroValidacao(mensagem) {
  const erro = new Error(mensagem);
  erro.statusCode = 400;
  return erro;
}

// Validação sintática feita ao cadastrar. A checagem de DNS acontece de novo a
// cada entrega, porque o registro pode mudar depois do cadastro.
function validarUrlWebhook(valor, { permitirLocal = false } = {}) {
  if (typeof valor !== 'string' || !valor.trim() || valor.length > MAX_URL) {
    throw erroValidacao('Informe a URL do webhook (até 2048 caracteres).');
  }
  let url;
  try { url = new URL(valor.trim()); } catch (e) { throw erroValidacao('URL do webhook inválida.'); }
  if (url.username || url.password) throw erroValidacao('A URL do webhook não pode conter usuário ou senha.');
  const protocolosAceitos = permitirLocal ? ['https:', 'http:'] : ['https:'];
  if (!protocolosAceitos.includes(url.protocol)) throw erroValidacao('A URL do webhook precisa usar HTTPS.');
  if (!permitirLocal) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && enderecoInterno(host))) {
      throw erroValidacao('A URL do webhook não pode apontar para a rede interna.');
    }
  }
  return url.toString();
}

function assinar(segredo, timestamp, corpo) {
  return crypto.createHmac('sha256', segredo).update(`${timestamp}.${corpo}`).digest('hex');
}

async function garantirDestinoPublico(url, resolverDns) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const enderecos = net.isIP(host) ? [{ address: host }] : await resolverDns(host, { all: true });
  if (!enderecos.length || enderecos.some(({ address }) => enderecoInterno(address))) {
    throw new Error('Destino do webhook resolve para a rede interna.');
  }
}

/**
 * Entrega um evento com reenvio simples em memória (sem fila persistente: se o
 * serviço reiniciar no meio dos reenvios, o evento se perde). Resolve com
 * { ok, tentativas, erro? } e nunca rejeita — quem chama só audita.
 */
async function entregarWebhook(destino, evento, dados, opcoes = {}) {
  const {
    permitirLocal = false,
    atrasosMs = ATRASOS_REENVIO_MS,
    timeoutMs = TIMEOUT_ENTREGA_MS,
    fetchImpl = fetch,
    resolverDns = dns.lookup,
  } = opcoes;
  const id = crypto.randomUUID();
  const corpo = JSON.stringify({ id, evento, dados });
  let ultimoErro = null;

  for (let tentativa = 0; tentativa <= atrasosMs.length; tentativa++) {
    if (tentativa > 0) await new Promise((resolver) => setTimeout(resolver, atrasosMs[tentativa - 1]));
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), timeoutMs);
    try {
      if (!permitirLocal) await garantirDestinoPublico(destino.url, resolverDns);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const resposta = await fetchImpl(destino.url, {
        method: 'POST',
        // Redirecionamento poderia levar a entrega para um destino não validado.
        redirect: 'manual',
        signal: controle.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': id,
          'X-Webhook-Evento': evento,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Assinatura': `sha256=${assinar(destino.segredo, timestamp, corpo)}`,
        },
        body: corpo,
      });
      if (resposta.status >= 200 && resposta.status < 300) return { ok: true, tentativas: tentativa + 1 };
      ultimoErro = `Webhook respondeu ${resposta.status}`;
      // Erro do receptor que não muda com o tempo (ex.: assinatura recusada): não insiste.
      if (resposta.status >= 400 && resposta.status < 500 && ![408, 429].includes(resposta.status)) {
        return { ok: false, tentativas: tentativa + 1, erro: ultimoErro };
      }
    } catch (erro) {
      ultimoErro = erro.name === 'AbortError' ? 'Webhook não respondeu a tempo' : erro.message;
      if (/rede interna/.test(ultimoErro)) return { ok: false, tentativas: tentativa + 1, erro: ultimoErro };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, tentativas: atrasosMs.length + 1, erro: ultimoErro };
}

module.exports = { validarUrlWebhook, assinar, entregarWebhook, enderecoInterno };
