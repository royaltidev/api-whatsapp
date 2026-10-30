const MAX_TEXTO_RECEBIDO = 4096;

// Converte uma mensagem recebida no formato entregue pelo webhook. Só
// conversas individuais interessam: grupos (@g.us), status, listas de
// transmissão e canais ficam de fora. Contas migradas para LID chegam como
// "<id>@lid" e precisam ser traduzidas para o telefone, que é o que o
// software cliente conhece.
async function extrairMensagemRecebida(msg, client) {
  if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return null;
  const remetente = String(msg.from || '');
  let jidTelefone = null;
  if (remetente.endsWith('@c.us')) {
    jidTelefone = remetente;
  } else if (remetente.endsWith('@lid')) {
    const [par] = await client.getContactLidAndPhone([remetente]);
    jidTelefone = par?.pn || null;
  } else {
    return null;
  }
  const telefone = String(jidTelefone || '').split('@')[0].replace(/\D/g, '');
  if (!telefone) return null;
  const tipo = msg.type || 'desconhecido';
  return {
    mensagem_id: msg.id?._serialized || null,
    telefone,
    tipo,
    // Áudio, imagem etc. também contam como resposta; só o texto puro vai junto.
    texto: tipo === 'chat' ? String(msg.body || '').slice(0, MAX_TEXTO_RECEBIDO) : null,
    recebido_em: new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
}

const TIPOS_DE_SISTEMA = new Set(['e2e_notification', 'notification', 'notification_template', 'protocol', 'gp2', 'call_log', 'revoked']);

async function telefoneDoJid(jid, client) {
  const id = String(jid || '');
  let jidTelefone = null;
  if (id.endsWith('@c.us')) jidTelefone = id;
  else if (id.endsWith('@lid')) {
    const [par] = await client.getContactLidAndPhone([id]);
    jidTelefone = par?.pn || null;
  }
  return String(jidTelefone || '').split('@')[0].replace(/\D/g, '') || null;
}

// Formato v2: todas as mensagens do número, recebidas e enviadas, individuais e de
// grupo (contrato em docs/runbooks/api-whatsapp-todas-as-mensagens.md do Like).
// Os campos antigos continuam, então um receptor v1 segue funcionando.
async function extrairMensagem(msg, client) {
  if (!msg || msg.isStatus || msg.broadcast || TIPOS_DE_SISTEMA.has(msg.type)) return null;
  const enviada = Boolean(msg.fromMe);
  const conversa = String((enviada ? msg.to : msg.from) || '');
  if (conversa === 'status@broadcast') return null;
  const grupo = conversa.endsWith('@g.us');
  let telefone;
  let participante = null;
  if (grupo) {
    telefone = conversa.split('@')[0];
    participante = enviada ? null : await telefoneDoJid(msg.author, client);
  } else {
    telefone = await telefoneDoJid(conversa, client);
  }
  if (!telefone) return null;
  const tipo = msg.type || 'desconhecido';
  const temMidia = Boolean(msg.hasMedia) || (tipo !== 'chat' && tipo !== 'desconhecido');
  const corpo = String(msg.body || '').slice(0, MAX_TEXTO_RECEBIDO);
  const em = new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  return {
    versao: 2,
    mensagem_id: msg.id?._serialized || null,
    telefone,
    direcao: enviada ? 'enviada' : 'recebida',
    grupo,
    participante,
    tipo,
    texto: tipo === 'chat' ? corpo : null,
    tem_midia: temMidia,
    legenda: temMidia && tipo !== 'chat' && corpo ? corpo : null,
    duracao_s: Number.isFinite(Number(msg.duration)) && Number(msg.duration) > 0 ? Number(msg.duration) : null,
    em,
    recebido_em: em,
  };
}

module.exports = { extrairMensagemRecebida, extrairMensagem };
