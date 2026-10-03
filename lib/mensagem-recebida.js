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

module.exports = { extrairMensagemRecebida };
