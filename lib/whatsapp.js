/**
 * Integração com WhatsApp Web (via whatsapp-web.js) para envio de mensagens.
 *
 * Importante: isso NÃO é a API oficial do WhatsApp Business. É uma
 * automação sobre o WhatsApp Web, como usam vários CRMs pequenos no
 * Brasil. Funciona pareando com um número de WhatsApp (escaneando um QR
 * code, como ao abrir o WhatsApp Web no navegador).
 *
 * whatsapp-web.js sobe um Chromium headless via Puppeteer por conexão (mais
 * pesado em RAM/CPU que um socket puro), rodando em segundo plano no
 * processo do servidor — sem qualquer relação com o navegador do usuário.
 *
 * Riscos a ter em mente:
 * - O WhatsApp pode bloquear/banir números usados para automação,
 *   principalmente em volume alto ou mandando para quem nunca
 *   conversou com esse número antes.
 * - A sessão fica salva em data/whatsapp-*-session — não apague se
 *   quiser manter a conexão sem escanear o QR de novo.
 *
 * Este módulo é uma FÁBRICA (criarConexaoWhatsapp): cada chamada devolve
 * uma conexão totalmente independente (próprio client/Chromium, próprio
 * status, própria pasta de sessão). Isso permite ter várias linhas de
 * WhatsApp simultâneas no mesmo processo.
 *
 * Extraído do projeto onboarding-app (sistema Like) em 2026-08-18 para virar
 * a base de um serviço de WhatsApp standalone, reutilizável por qualquer
 * aplicação que precise disparar mensagens (lembretes/alertas de sistema ou
 * campanhas de marketing) — ver server.js e README.md deste projeto.
 */
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { extrairMensagemRecebida, extrairMensagem } = require('./mensagem-recebida');

function criarConexaoWhatsapp(nomeSessao, pastaSessao, { aoReceberMensagem, entregarTodas = false } = {}) {
  const SESSION_DIR = pastaSessao || path.join(__dirname, '..', 'data', `whatsapp-${nomeSessao}-session`);
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  let client = null;
  let statusAtual = 'desconectado'; // 'desconectado' | 'conectando' | 'aguardando_qr' | 'conectado'
  let qrAtual = null;
  let ultimoErro = null;
  let numeroConectado = null;
  let conectadoDesde = null;
  let tentativasReconexao = 0;
  let jaTentouComSessaoNova = false;

  // Não há retry automático em segundo plano: qualquer falha de conexão
  // leva direto para o status "desconectado" (com o motivo em status().erro)
  // e fica assim até o usuário clicar em "Conectar WhatsApp" / "Conectar do
  // zero (novo QR)" na tela correspondente. Esses campos continuam
  // existindo só para compatibilidade com o status() consumido pelo front-end.
  const MAX_TENTATIVAS_AUTO = 5;

  // whatsapp-web.js precisa subir um Chromium (via Puppeteer) e carregar o
  // WhatsApp Web inteiro antes de responder com QR ou sucesso — mais lento
  // que um socket puro, principalmente na primeira execução (o Puppeteer
  // ainda pode estar descompactando/abrindo o binário). Damos mais margem
  // antes de considerar a tentativa travada.
  const TIMEOUT_PRIMEIRA_RESPOSTA_MS = 45000;
  let watchdogTimer = null;
  let inicioEmAndamento = null;
  let reconexaoEmAndamento = null;

  // Identifica cada tentativa de conexão. Evita que um evento tardio de uma
  // tentativa antiga (ex.: o "disconnected" de um client que já tínhamos
  // desistido e substituído por outro) mexa no estado da tentativa atual.
  let cicloAtual = 0;

  function limparWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function limparSessaoSalva() {
    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    } catch (e) {
      console.error(`Erro ao limpar sessão do WhatsApp (${nomeSessao}):`, e.message);
    }
  }

  // Formata o id conectado ("5511999998888@c.us" ou similar) como número de
  // telefone legível, sem depender de um formato rígido.
  function formatarNumero(jid) {
    const digits = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
      const ddd = digits.slice(2, 4);
      const resto = digits.slice(4);
      if (resto.length === 9) return `+55 (${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`;
      if (resto.length === 8) return `+55 (${ddd}) ${resto.slice(0, 4)}-${resto.slice(4)}`;
    }
    return `+${digits}`;
  }

  // Centraliza o que acontece quando uma tentativa de conexão não dá certo,
  // seja porque o client desconectou (evento "disconnected"/"auth_failure")
  // ou porque o relógio de segurança (watchdog) esgotou sem nenhuma resposta
  // do WhatsApp. Não tenta de novo sozinho: sempre encerra em
  // "desconectado", com o motivo em status().erro. A próxima tentativa só
  // acontece quando o usuário clicar em conectar de novo (reconectar() →
  // iniciar()).
  function tratarFalhaConexao(motivo, deslogado) {
    limparWatchdog();
    qrAtual = null;
    numeroConectado = null;
    conectadoDesde = null;
    ultimoErro = motivo || null;
    statusAtual = 'desconectado';
    tentativasReconexao = 0;
    jaTentouComSessaoNova = false;

    if (deslogado) {
      // O dispositivo foi removido do WhatsApp do celular (ou a sessão foi
      // encerrada do outro lado, ou as credenciais salvas estavam
      // corrompidas) — as credenciais salvas agora são inválidas. Limpa a
      // sessão aqui: sem isso, o próximo clique em "Conectar" reusaria
      // credenciais mortas e voltaria a falhar, sem nunca gerar um QR novo.
      limparSessaoSalva();
      console.log(`⚠️  WhatsApp (${nomeSessao}) desconectado (sessão encerrada). Chame reconectar() quando quiser conectar de novo.`);
      return;
    }

    // Qualquer outra falha (rede, timeout, etc.): mantém a sessão salva como
    // está — se ainda for válida, a próxima chamada a reconectar() reconecta
    // sem pedir QR de novo; se não for, o QR aparece naturalmente nessa
    // próxima tentativa. De qualquer forma, nada acontece sozinho aqui.
    console.log(`⚠️  WhatsApp (${nomeSessao}): falha ao conectar. Ficando em "desconectado" até chamar reconectar() de novo.`, motivo || '');
  }

  function buildClient() {
    // Estes flags só fazem sentido em hospedagem muito restrita. Nesta VPS há
    // memória e limite de processos suficientes; usar --single-process nela
    // piora a estabilidade do Puppeteer quando há várias sessões simultâneas.
    const flagsLinuxRestrito = process.env.WHATSAPP_CHROMIUM_RESTRITO === 'true'
      ? ['--no-zygote', '--single-process']
      : [];

    return new Client({
      authStrategy: new LocalAuth({
        clientId: nomeSessao,
        dataPath: SESSION_DIR,
      }),
      puppeteer: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--no-first-run',
          '--disable-crash-reporter',
          ...flagsLinuxRestrito,
        ],
      },
    });
  }

  async function iniciarInterno() {
    limparWatchdog();
    statusAtual = 'conectando';
    qrAtual = null;

    const meuCiclo = ++cicloAtual;

    client = buildClient();

    // Relógio de segurança: se nada acontecer (nem QR, nem sucesso, nem
    // erro) dentro do prazo, força o fim dessa tentativa em vez de deixar o
    // status preso em "conectando" indefinidamente.
    watchdogTimer = setTimeout(() => {
      if (meuCiclo !== cicloAtual) return;
      try { client?.destroy?.(); } catch (e) { /* ignora */ }
      console.log(`⚠️  WhatsApp (${nomeSessao}): sem resposta em tempo hábil.`);
      tratarFalhaConexao('Sem resposta do WhatsApp em tempo hábil (possível problema de rede/firewall).', false);
    }, TIMEOUT_PRIMEIRA_RESPOSTA_MS);

    client.on('qr', async (qr) => {
      if (meuCiclo !== cicloAtual) return;
      limparWatchdog(); // a partir daqui a espera é do usuário (escanear), não da rede
      try {
        qrAtual = await QRCode.toDataURL(qr);
      } catch (e) {
        qrAtual = null;
      }
      if (meuCiclo !== cicloAtual) return;
      statusAtual = 'aguardando_qr';
    });

    client.on('ready', () => {
      if (meuCiclo !== cicloAtual) return;
      limparWatchdog();
      statusAtual = 'conectado';
      qrAtual = null;
      ultimoErro = null;
      tentativasReconexao = 0;
      jaTentouComSessaoNova = false;
      numeroConectado = formatarNumero(client.info?.wid?._serialized);
      conectadoDesde = new Date().toISOString();
      console.log(`✅ WhatsApp (${nomeSessao}) conectado (${numeroConectado || 'número desconhecido'})`);
    });

    client.on('auth_failure', (mensagem) => {
      if (meuCiclo !== cicloAtual) return;
      console.error(`[${nomeSessao}] Falha de autenticação:`, mensagem);
      // Credenciais salvas inválidas/corrompidas — trata como "deslogado"
      // para já descartar a sessão e a próxima tentativa nascer pedindo QR.
      tratarFalhaConexao(mensagem, true);
    });

    client.on('disconnected', (motivo) => {
      if (meuCiclo !== cicloAtual) return;
      console.error(`[${nomeSessao}] Sessão desconectada:`, motivo);
      // 'LOGOUT'/'UNPAIRED'/'UNPAIRED_IDLE': o aparelho foi removido do
      // WhatsApp do celular (ou a sessão foi encerrada do outro lado) — as
      // credenciais salvas ficam inválidas.
      const deslogado = motivo === 'LOGOUT' || motivo === 'UNPAIRED' || motivo === 'UNPAIRED_IDLE';
      tratarFalhaConexao(motivo, deslogado);
    });

    if (aoReceberMensagem) {
      const processar = async (msg) => {
        if (meuCiclo !== cicloAtual) return;
        try {
          const dados = entregarTodas ? await extrairMensagem(msg, client) : await extrairMensagemRecebida(msg, client);
          if (dados) aoReceberMensagem(dados);
        } catch (e) {
          console.error(`[${nomeSessao}] Falha ao processar mensagem:`, e.message);
        }
      };
      client.on('message', processar);
      // 'message_create' dispara também para as enviadas (celular ou API); as recebidas já vêm de 'message'.
      if (entregarTodas) client.on('message_create', (msg) => { if (msg?.fromMe) processar(msg); });
    }

    try {
      await client.initialize();
    } catch (e) {
      if (meuCiclo !== cicloAtual) return;
      tratarFalhaConexao(e.message, false);
    }
  }

  // Uma conexão não pode ter duas inicializações em paralelo. O WhatsApp Web
  // injeta bindings no mesmo contexto Chromium e chamadas concorrentes causam
  // erros como "onQRChangedEvent already exists".
  function iniciar({ forcar = false } = {}) {
    if (inicioEmAndamento && !forcar) return inicioEmAndamento;
    const tentativa = iniciarInterno();
    inicioEmAndamento = tentativa;
    tentativa.finally(() => {
      if (inicioEmAndamento === tentativa) inicioEmAndamento = null;
    }).catch(() => {});
    return tentativa;
  }

  // Força uma nova tentativa de conexão agora — usado tanto pelo botão
  // "Tentar novamente"/"Conectar WhatsApp" (primeira conexão ou depois de um
  // erro) quanto por "Gerar novo QR" quando a sessão ficou presa.
  async function reconectar() {
    if (reconexaoEmAndamento) return reconexaoEmAndamento;
    reconexaoEmAndamento = (async () => {
      tentativasReconexao = 0;
      jaTentouComSessaoNova = false;
      limparWatchdog();
      cicloAtual++; // invalida eventos de qualquer tentativa anterior
      const clientAnterior = client;
      client = null;
      if (clientAnterior) {
        try { await clientAnterior.destroy(); } catch (e) { /* pode já estar destruído */ }
      }
      // Força um ciclo novo sem reutilizar uma Promise de inicialização antiga.
      await iniciar({ forcar: true });
    })().finally(() => { reconexaoEmAndamento = null; });
    return reconexaoEmAndamento;
  }

  // Desconecta de vez: encerra a sessão do lado do WhatsApp (o aparelho some
  // de "Aparelhos conectados" no celular) e apaga as credenciais salvas
  // localmente, deixando pronto pra parear um número diferente do zero.
  async function desconectar() {
    limparWatchdog();
    cicloAtual++; // invalida qualquer tentativa em andamento
    try {
      if (client) await client.logout();
    } catch (e) {
      // A sessão pode já estar inválida do lado do WhatsApp — segue com a
      // limpeza local de qualquer forma.
    }
    try {
      if (client) await client.destroy();
    } catch (e) { /* ignora — pode já estar destruído pelo logout() */ }
    client = null;
    statusAtual = 'desconectado';
    qrAtual = null;
    ultimoErro = null;
    numeroConectado = null;
    conectadoDesde = null;
    tentativasReconexao = 0;
    jaTentouComSessaoNova = false;

    limparSessaoSalva();
  }

  // Encerra somente o Chromium atual, preservando as credenciais locais. É
  // usado pelo painel administrativo para recuperar processos travados; uma
  // nova chamada a iniciar() reutiliza a sessão sem exigir outro QR.
  async function parar() {
    limparWatchdog();
    cicloAtual++;
    try {
      if (client) await client.destroy();
    } catch (e) { /* processo pode já ter encerrado */ }
    client = null;
    statusAtual = 'desconectado';
    qrAtual = null;
    ultimoErro = 'Processo encerrado pelo administrador.';
    numeroConectado = null;
    conectadoDesde = null;
  }

  function status() {
    return {
      status: statusAtual,
      qr: qrAtual,
      erro: ultimoErro,
      numero: numeroConectado,
      conectado_desde: conectadoDesde,
      tentativas: tentativasReconexao,
      max_tentativas: MAX_TENTATIVAS_AUTO,
      tentando_sessao_nova: jaTentouComSessaoNova,
    };
  }

  // Normaliza telefone brasileiro (com/sem DDI, com/sem 9º dígito) para o
  // formato de id usado pelo WhatsApp.
  function normalizarTelefone(telefone) {
    let numero = String(telefone).replace(/\D/g, '');
    if (!numero.startsWith('55')) {
      numero = '55' + numero;
    }
    return numero;
  }

  // Resolve o id real do WhatsApp (WID/LID) antes de enviar. Montar
  // "<numero>@c.us" na mão e mandar direto pro sendMessage falha com
  // "No LID for user" em números que a sessão ainda não conhece (sem
  // chat/contato prévio) — é preciso resolver via getNumberId primeiro.
  async function resolverChatId(telefone) {
    const numero = normalizarTelefone(telefone);
    const resultado = await client.getNumberId(`${numero}@c.us`);
    if (!resultado) {
      throw new Error(`O número ${telefone} não foi encontrado no WhatsApp. Confira o DDD e o número.`);
    }
    return resultado._serialized;
  }

  // texto: obrigatório. imagem: opcional — string (caminho de arquivo local no
  // servidor) OU objeto { base64, mimetype, nome } (usado por quem não tem
  // acesso ao arquivo local de quem chamou — ver server.js).
  async function enviarMensagem(telefone, texto, imagem) {
    if (statusAtual !== 'conectado' || !client) {
      throw new Error(`WhatsApp (${nomeSessao}) não está conectado. Escaneie o QR na tela correspondente.`);
    }
    const chatId = await resolverChatId(telefone);

    if (imagem) {
      const media = typeof imagem === 'string'
        ? MessageMedia.fromFilePath(imagem)
        : new MessageMedia(imagem.mimetype, imagem.base64, imagem.nome);
      await client.sendMessage(chatId, media, { caption: texto });
    } else {
      await client.sendMessage(chatId, texto);
    }
  }

  return { iniciar, status, enviarMensagem, reconectar, desconectar, parar };
}

module.exports = { criarConexaoWhatsapp };
