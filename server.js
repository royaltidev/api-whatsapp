require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');
const { criarConexaoWhatsapp } = require('./lib/whatsapp');
const { validarUrlWebhook, entregarWebhook } = require('./lib/webhook');

// whatsapp-web.js/Puppeteer pode rejeitar uma operação interna durante uma
// navegação do WhatsApp Web. Registre a falha sem derrubar todas as demais
// integrações; a conexão afetada continua exibindo seu estado no dashboard.
process.on('unhandledRejection', (erro) => console.error('Promise não tratada no WhatsApp:', erro?.message || erro));
process.on('uncaughtException', (erro) => console.error('Exceção isolada no WhatsApp:', erro?.message || erro));

const CHAVE_ADMIN = process.env.WHATSAPP_API_KEY;
const PORT = process.env.WHATSAPP_SERVICO_PORT || 4000;
const MAX_CLIENTES = Number(process.env.WHATSAPP_MAX_CLIENTES || 10);
const WEBHOOK_PERMITIR_LOCAL = process.env.WHATSAPP_WEBHOOK_PERMITIR_LOCAL === 'true';
// Payload v2 (todas as mensagens). Desligado por padrão: ligue só depois que o software cliente aceitar `direcao`.
const ENTREGAR_TODAS = process.env.WHATSAPP_ENTREGAR_TODAS === 'true';
const DATA_DIR = path.join(__dirname, 'data');
const CLIENTES_DIR = path.join(DATA_DIR, 'clientes');
const ARQUIVO_CLIENTES = path.join(DATA_DIR, 'clientes.json');
const ARQUIVO_PAINEL = path.join(DATA_DIR, 'painel-admin.json');
const URL_PUBLICA = (process.env.ADMIN_PUBLIC_URL || 'https://api.crmlive.com.br').replace(/\/$/, '');
const EMAIL_RECUPERACAO = process.env.ADMIN_RECOVERY_EMAIL;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
if (!CHAVE_ADMIN) throw new Error('Defina WHATSAPP_API_KEY no .env antes de rodar este serviço.');
fs.mkdirSync(CLIENTES_DIR, { recursive: true });

const hash = (valor) => crypto.createHash('sha256').update(valor).digest();
const hashHex = (valor) => hash(valor).toString('hex');
const compararSegredo = (recebido, esperado) => crypto.timingSafeEqual(hash(recebido || ''), hash(esperado));
function lerClientes() {
  try { const dados = JSON.parse(fs.readFileSync(ARQUIVO_CLIENTES, 'utf8')); return Array.isArray(dados) ? dados : []; }
  catch (erro) { if (erro.code === 'ENOENT') return []; throw new Error(`Não foi possível ler clientes: ${erro.message}`); }
}
let clientes = lerClientes();
function salvarClientes() {
  const temporario = `${ARQUIVO_CLIENTES}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, `${JSON.stringify(clientes, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporario, ARQUIVO_CLIENTES);
  fs.chmodSync(ARQUIVO_CLIENTES, 0o600);
}
const validarId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(id);
const conexoesClientes = new Map();
const inicializacoes = new Map();
let filaInicializacao = Promise.resolve();
function enfileirarInicializacao(tarefa) {
  const proxima = filaInicializacao.then(tarefa, tarefa);
  filaInicializacao = proxima.catch(() => {});
  return proxima;
}
function clientePublico(cliente, conexao) {
  return { id: cliente.id, nome: cliente.nome, criado_em: cliente.criado_em, status: conexao?.status().status || 'nao_iniciado', webhook_configurado: Boolean(cliente.webhook_url) };
}
function auditar(cliente, acao) {
  console.log(JSON.stringify({ evento: 'api_whatsapp', cliente: cliente.id, acao, em: new Date().toISOString() }));
}
async function obterConexaoCliente(cliente) {
  const existente = conexoesClientes.get(cliente.id);
  if (existente) return existente;
  const iniciando = inicializacoes.get(cliente.id);
  if (iniciando) return iniciando;
  if (conexoesClientes.size >= MAX_CLIENTES) {
    const erro = new Error(`Limite de ${MAX_CLIENTES} conexões simultâneas atingido.`); erro.statusCode = 503; throw erro;
  }
  const conexao = criarConexaoWhatsapp(`cliente-${cliente.id}`, path.join(CLIENTES_DIR, cliente.id, 'whatsapp-session'), {
    aoReceberMensagem: (dados) => notificarMensagemRecebida(cliente.id, dados),
    entregarTodas: ENTREGAR_TODAS,
  });
  conexoesClientes.set(cliente.id, conexao);
  const inicio = enfileirarInicializacao(() => conexao.iniciar()).then(() => conexao).catch((erro) => { conexoesClientes.delete(cliente.id); throw erro; }).finally(() => inicializacoes.delete(cliente.id));
  inicializacoes.set(cliente.id, inicio);
  return inicio;
}
// Busca o cadastro atual a cada mensagem: o webhook pode ter sido trocado ou o
// cliente revogado depois que a conexão subiu. O conteúdo da mensagem nunca
// vai para o log, só o resultado da entrega.
function notificarMensagemRecebida(clienteId, dados) {
  const cliente = clientes.find((item) => item.id === clienteId);
  if (!cliente?.webhook_url || !cliente.webhook_segredo) return;
  entregarWebhook({ url: cliente.webhook_url, segredo: cliente.webhook_segredo }, 'mensagem_recebida', dados, { permitirLocal: WEBHOOK_PERMITIR_LOCAL })
    .then((resultado) => auditar(cliente, resultado.ok ? 'webhook_entregue' : `webhook_falhou: ${resultado.erro}`));
}
function autenticarAdmin(req, res, next) {
  if (!compararSegredo(req.header('X-Admin-API-Key') || '', CHAVE_ADMIN)) return res.status(401).json({ erro: 'Chave administrativa inválida' });
  next();
}
function autenticarCliente(req, res, next) {
  const cliente = clientes.find((item) => item.token_hash === hashHex(req.header('X-API-Key') || ''));
  if (!cliente) return res.status(401).json({ erro: 'Chave de API inválida' });
  req.cliente = cliente; next();
}
function responderErro(res, erro, mensagem) { res.status(erro.statusCode || 500).json({ erro: erro.message || mensagem }); }

function lerPainel() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO_PAINEL, 'utf8')); }
  catch (erro) { if (erro.code === 'ENOENT') return null; throw erro; }
}
let painel = lerPainel();
const sessoesPainel = new Map();
const tentativasLogin = new Map();
const tentativasRecuperacao = new Map();
const DURACAO_TOKEN_RECUPERACAO_MS = 30 * 60 * 1000;
const INTERVALO_RECUPERACAO_MS = 2 * 60 * 1000;
function senhaHash(senha, salt) { return crypto.scryptSync(senha, salt, 64).toString('hex'); }
function salvarPainel(dados) {
  const temporario = `${ARQUIVO_PAINEL}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, `${JSON.stringify(dados)}\n`, { mode: 0o600 });
  fs.renameSync(temporario, ARQUIVO_PAINEL); fs.chmodSync(ARQUIVO_PAINEL, 0o600);
}
function cookie(req, nome) {
  return (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(`${nome}=`))?.slice(nome.length + 1);
}
function sessaoPainel(req) {
  const token = cookie(req, 'wa_admin_session');
  const sessao = token && sessoesPainel.get(token);
  if (!sessao || sessao.expira < Date.now()) { if (token) sessoesPainel.delete(token); return null; }
  return sessao;
}
function exigirPainel(req, res, next) {
  if (!sessaoPainel(req)) return res.status(401).json({ erro: 'Faça login no painel.' });
  next();
}
function encerrarConexao(id, conexao) {
  return conexao.parar().finally(() => { conexoesClientes.delete(id); inicializacoes.delete(id); });
}
function configuracaoRecuperacaoValida() {
  return Boolean(EMAIL_RECUPERACAO && SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_PORT);
}
function limparTokenRecuperacao() {
  if (!painel) return;
  delete painel.recuperacao_token_hash;
  delete painel.recuperacao_expira_em;
  delete painel.recuperacao_solicitada_em;
}
async function enviarEmailRecuperacao(link) {
  const transporte = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporte.sendMail({
    from: `Central WhatsApp <${SMTP_USER}>`,
    to: EMAIL_RECUPERACAO,
    subject: 'Redefinição de senha — Central WhatsApp',
    text: `Foi solicitada uma redefinição de senha para a Central WhatsApp. Use este link em até 30 minutos:\n\n${link}\n\nSe você não solicitou esta ação, ignore este e-mail.`,
  });
}

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use('/admin', express.static(path.join(__dirname, 'public'), { index: 'admin.html' }));

// O assistente de ativação só existe até a primeira conta ser criada. Depois
// disso, login usa cookie HttpOnly/Secure e as sessões expiram em oito horas.
app.get('/admin/api/estado', (req, res) => res.json({ configurado: Boolean(painel), autenticado: Boolean(sessaoPainel(req)) }));
app.post('/admin/api/configurar', (req, res) => {
  if (painel) return res.status(404).json({ erro: 'Rota de ativação indisponível.' });
  const { usuario, senha } = req.body || {};
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(usuario || '')) return res.status(400).json({ erro: 'Usuário inválido.' });
  if (typeof senha !== 'string' || senha.length < 12) return res.status(400).json({ erro: 'A senha deve ter ao menos 12 caracteres.' });
  const salt = crypto.randomBytes(16).toString('hex');
  painel = { usuario, salt, senha_hash: senhaHash(senha, salt) };
  salvarPainel(painel);
  res.status(201).json({ ok: true });
});
app.post('/admin/api/login', (req, res) => {
  if (!painel) return res.status(409).json({ erro: 'Crie a primeira conta antes de entrar.' });
  const ip = req.ip || req.socket.remoteAddress || 'desconhecido';
  const tentativa = tentativasLogin.get(ip);
  if (tentativa && tentativa.bloqueadoAte > Date.now()) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  const { usuario, senha } = req.body || {};
  const correta = typeof senha === 'string' && usuario === painel.usuario && compararSegredo(senhaHash(senha, painel.salt), painel.senha_hash);
  if (!correta) {
    const falhas = (tentativa?.falhas || 0) + 1;
    tentativasLogin.set(ip, { falhas, bloqueadoAte: falhas >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
    return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
  }
  tentativasLogin.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  sessoesPainel.set(token, { expira: Date.now() + 8 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', `wa_admin_session=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
  res.json({ ok: true });
});
app.post('/admin/api/recuperar-senha', async (req, res) => {
  // A resposta é igual para usuário inexistente e existente, evitando revelar
  // qual conta administra o painel. O destino nunca vem do navegador.
  const ip = req.ip || req.socket.remoteAddress || 'desconhecido';
  const ultimaTentativa = tentativasRecuperacao.get(ip) || 0;
  if (ultimaTentativa + INTERVALO_RECUPERACAO_MS > Date.now()) {
    return res.status(429).json({ erro: 'Aguarde um minuto antes de solicitar outro link.' });
  }
  tentativasRecuperacao.set(ip, Date.now());
  if (!painel || !configuracaoRecuperacaoValida()) {
    return res.json({ ok: true });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  painel.recuperacao_token_hash = hashHex(token);
  painel.recuperacao_expira_em = Date.now() + DURACAO_TOKEN_RECUPERACAO_MS;
  painel.recuperacao_solicitada_em = new Date().toISOString();
  salvarPainel(painel);
  try {
    // O token fica no fragmento: ele não é enviado ao servidor nem registrado
    // nos logs do proxy/requisição.
    await enviarEmailRecuperacao(`${URL_PUBLICA}/admin/#redefinir-senha=${token}`);
    console.log(JSON.stringify({ evento: 'api_whatsapp', acao: 'recuperacao_senha_enviada', em: new Date().toISOString() }));
  } catch (erro) {
    limparTokenRecuperacao(); salvarPainel(painel);
    console.error('Falha ao enviar e-mail de recuperação:', erro.message);
    return res.status(503).json({ erro: 'Não foi possível enviar o link de recuperação. Tente novamente em alguns minutos.' });
  }
  res.json({ ok: true });
});
app.post('/admin/api/redefinir-senha', (req, res) => {
  const { token, senha } = req.body || {};
  const tokenValido = painel
    && typeof token === 'string'
    && painel.recuperacao_token_hash
    && Number(painel.recuperacao_expira_em) > Date.now()
    && compararSegredo(hashHex(token), painel.recuperacao_token_hash);
  if (!tokenValido) return res.status(400).json({ erro: 'Este link é inválido ou expirou. Solicite outro.' });
  if (typeof senha !== 'string' || senha.length < 12) return res.status(400).json({ erro: 'A senha deve ter ao menos 12 caracteres.' });
  const salt = crypto.randomBytes(16).toString('hex');
  painel.salt = salt;
  painel.senha_hash = senhaHash(senha, salt);
  limparTokenRecuperacao();
  salvarPainel(painel);
  sessoesPainel.clear();
  console.log(JSON.stringify({ evento: 'api_whatsapp', acao: 'senha_painel_redefinida', em: new Date().toISOString() }));
  res.json({ ok: true });
});
app.post('/admin/api/logout', exigirPainel, (req, res) => {
  const token = cookie(req, 'wa_admin_session'); if (token) sessoesPainel.delete(token);
  res.setHeader('Set-Cookie', 'wa_admin_session=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0'); res.json({ ok: true });
});
app.get('/admin/api/conexoes', exigirPainel, (req, res) => {
  const clienteStatus = clientes.map((cliente) => ({ ...clientePublico(cliente, conexoesClientes.get(cliente.id)), ...(conexoesClientes.get(cliente.id)?.status() || {}) }));
  res.json({ clientes: clienteStatus, memoria_mb: Math.round(process.memoryUsage().rss / 1024 / 1024), processos_ativos: conexoesClientes.size });
});
app.post('/admin/api/clientes', exigirPainel, (req, res) => {
  const { id, nome } = req.body || {};
  if (!validarId(id)) return res.status(400).json({ erro: 'Use 2 a 63 caracteres: minúsculas, números e hífen.' });
  if (typeof nome !== 'string' || !nome.trim() || nome.length > 120) return res.status(400).json({ erro: 'Informe o nome da aplicação.' });
  if (clientes.some((cliente) => cliente.id === id)) return res.status(409).json({ erro: 'Já existe uma integração com este ID.' });
  const token = crypto.randomBytes(32).toString('hex');
  const cliente = { id, nome: nome.trim(), token_hash: hashHex(token), criado_em: new Date().toISOString() };
  clientes.push(cliente); salvarClientes(); auditar(cliente, 'cliente_criado_painel');
  res.status(201).json({ cliente: clientePublico(cliente), token });
});
app.post('/admin/api/clientes/:id/rotacionar', exigirPainel, (req, res) => {
  const cliente = clientes.find((item) => item.id === req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Integração não encontrada.' });
  const token = crypto.randomBytes(32).toString('hex');
  cliente.token_hash = hashHex(token); salvarClientes(); auditar(cliente, 'token_rotacionado');
  res.json({ token });
});
app.delete('/admin/api/clientes/:id', exigirPainel, async (req, res) => {
  const indice = clientes.findIndex((cliente) => cliente.id === req.params.id);
  if (indice === -1) return res.status(404).json({ erro: 'Integração não encontrada.' });
  const [cliente] = clientes.splice(indice, 1);
  try { await conexoesClientes.get(cliente.id)?.desconectar(); } catch (erro) { console.error(erro.message); }
  conexoesClientes.delete(cliente.id); inicializacoes.delete(cliente.id);
  fs.rmSync(path.join(CLIENTES_DIR, cliente.id), { recursive: true, force: true }); salvarClientes(); auditar(cliente, 'cliente_revogado_painel');
  res.json({ ok: true });
});
app.post('/admin/api/clientes/:id/encerrar', exigirPainel, async (req, res) => {
  const conexao = conexoesClientes.get(req.params.id);
  if (!conexao) return res.status(404).json({ erro: 'Não há processo ativo para este cliente.' });
  try { await encerrarConexao(req.params.id, conexao); res.json({ ok: true }); } catch (erro) { responderErro(res, erro, 'Erro ao encerrar processo'); }
});
app.post('/admin/api/reiniciar', exigirPainel, (req, res) => {
  res.status(202).json({ ok: true }); setTimeout(() => process.exit(0), 250);
});

// A chave administrativa só cria, lista e revoga integrações. O token de cada
// software é retornado uma única vez e salvo no servidor apenas como hash.
app.post('/v1/clientes', autenticarAdmin, (req, res) => {
  const { id, nome } = req.body || {};
  if (!validarId(id)) return res.status(400).json({ erro: 'id deve ter 2 a 63 caracteres: minúsculas, números e hífen.' });
  if (typeof nome !== 'string' || !nome.trim() || nome.length > 120) return res.status(400).json({ erro: 'Informe um nome de até 120 caracteres.' });
  if (clientes.some((cliente) => cliente.id === id)) return res.status(409).json({ erro: 'Já existe um cliente com este id.' });
  const token = crypto.randomBytes(32).toString('hex');
  const cliente = { id, nome: nome.trim(), token_hash: hashHex(token), criado_em: new Date().toISOString() };
  clientes.push(cliente); salvarClientes(); auditar(cliente, 'cliente_criado');
  res.status(201).json({ cliente: clientePublico(cliente), token });
});
app.get('/v1/clientes', autenticarAdmin, (req, res) => {
  res.json({ clientes: clientes.map((cliente) => clientePublico(cliente, conexoesClientes.get(cliente.id))) });
});
app.delete('/v1/clientes/:id', autenticarAdmin, async (req, res) => {
  const indice = clientes.findIndex((cliente) => cliente.id === req.params.id);
  if (indice === -1) return res.status(404).json({ erro: 'Cliente não encontrado.' });
  const [cliente] = clientes.splice(indice, 1);
  try { await conexoesClientes.get(cliente.id)?.desconectar(); } catch (erro) { console.error(erro.message); }
  conexoesClientes.delete(cliente.id); inicializacoes.delete(cliente.id);
  fs.rmSync(path.join(CLIENTES_DIR, cliente.id), { recursive: true, force: true });
  salvarClientes(); auditar(cliente, 'cliente_revogado'); res.json({ ok: true });
});

// O token identifica a conexão. Não existe id de cliente na URL, assim um
// software não consegue selecionar ou operar a sessão WhatsApp de outro.
app.get('/v1/whatsapp/status', autenticarCliente, async (req, res) => {
  try { const conexao = await obterConexaoCliente(req.cliente); res.json({ cliente: clientePublico(req.cliente, conexao), ...conexao.status() }); }
  catch (erro) { responderErro(res, erro, 'Erro ao consultar conexão'); }
});
app.post('/v1/whatsapp/reconectar', autenticarCliente, async (req, res) => {
  try { const conexao = await obterConexaoCliente(req.cliente); await conexao.reconectar(); auditar(req.cliente, 'reconectar'); res.json({ cliente: clientePublico(req.cliente, conexao), ...conexao.status() }); }
  catch (erro) { responderErro(res, erro, 'Erro ao reconectar'); }
});
app.post('/v1/whatsapp/desconectar', autenticarCliente, async (req, res) => {
  try { const conexao = await obterConexaoCliente(req.cliente); await conexao.desconectar(); auditar(req.cliente, 'desconectar'); res.json({ ok: true }); }
  catch (erro) { responderErro(res, erro, 'Erro ao desconectar'); }
});
app.post('/v1/whatsapp/enviar', autenticarCliente, async (req, res) => {
  const { telefone, texto, imagemBase64, imagemMime, imagemNome } = req.body || {};
  if (!telefone || !texto) return res.status(400).json({ erro: 'Informe telefone e texto' });
  try {
    const conexao = await obterConexaoCliente(req.cliente);
    const imagem = imagemBase64 ? { base64: imagemBase64, mimetype: imagemMime, nome: imagemNome } : undefined;
    await conexao.enviarMensagem(telefone, texto, imagem); auditar(req.cliente, 'mensagem_enviada'); res.json({ ok: true });
  } catch (erro) { responderErro(res, erro, 'Erro ao enviar mensagem'); }
});

// Webhook do próprio cliente. O segredo de assinatura é gerado aqui e
// devolvido uma única vez; cada PUT gera um segredo novo. Diferente do token,
// ele fica guardado em claro (arquivo 0600), porque é necessário para assinar.
app.get('/v1/whatsapp/webhook', autenticarCliente, (req, res) => {
  res.json({ configurado: Boolean(req.cliente.webhook_url), url: req.cliente.webhook_url || null });
});
app.put('/v1/whatsapp/webhook', autenticarCliente, (req, res) => {
  try {
    const url = validarUrlWebhook(req.body?.url, { permitirLocal: WEBHOOK_PERMITIR_LOCAL });
    const segredo = crypto.randomBytes(32).toString('hex');
    req.cliente.webhook_url = url; req.cliente.webhook_segredo = segredo;
    salvarClientes(); auditar(req.cliente, 'webhook_configurado');
    res.json({ configurado: true, url, segredo });
  } catch (erro) { responderErro(res, erro, 'Erro ao configurar webhook'); }
});
app.delete('/v1/whatsapp/webhook', autenticarCliente, (req, res) => {
  delete req.cliente.webhook_url; delete req.cliente.webhook_segredo;
  salvarClientes(); auditar(req.cliente, 'webhook_removido'); res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => console.log(`Serviço WhatsApp rodando em http://127.0.0.1:${PORT}`));
