# API WhatsApp

Serviço standalone que expõe conexões de WhatsApp (via [whatsapp-web.js](https://wwebjs.dev/)) por HTTP, para qualquer aplicação disparar mensagens — lembretes/alertas de sistema ou campanhas de marketing — sem precisar rodar um Chromium no próprio processo.

Extraído do projeto **onboarding-app** (sistema Like) em 2026-08-18, onde esse mesmo código resolvia o problema de "hospedagem compartilhada não suporta Chromium" (ver `whatsapp-servidor-remoto.js` / `whatsapp-cliente-remoto.js` naquele repo). Aqui ele vira um serviço independente, para ser reutilizado por qualquer sistema.

## O que isso NÃO é

Não é a API oficial do WhatsApp Business — é automação sobre o WhatsApp Web (parear escaneando QR code, como vários CRMs pequenos fazem). O WhatsApp pode bloquear/banir números usados assim, principalmente em volume alto ou mandando para quem nunca conversou com esse número.

## Instalar e rodar

Funciona tanto em Linux quanto em Windows (o Chromium do Puppeteer roda embutido; os flags de otimização de processo que dependem de Linux só são aplicados quando `process.platform === 'linux'` — ver `lib/whatsapp.js`).

1. Instale as dependências:
   ```
   npm install
   ```
2. Copie `.env.example` para `.env` e defina:
   - `WHATSAPP_API_KEY`: chave compartilhada que os clientes HTTP vão enviar no header `X-API-Key` (gere algo aleatório e longo).
   - `WHATSAPP_SERVICO_PORT` (opcional, padrão `4000`).
3. Rode:
   ```
   npm start
   ```
4. Escaneie o QR: hoje não há endpoint HTTP pra buscar o QR (ele fica em `status().qr`, como data URL) — a forma mais simples é adaptar um endpoint temporário ou reaproveitar a tela de admin do sistema cliente (ex.: a tela Ajustes > Gerais > Whatsapp do onboarding-app, se estiver consumindo daqui). Ver "Próximos passos" abaixo.
5. Exponha a porta para a internet via túnel (ex.: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), `cloudflared`) — **nunca diretamente**. O servidor já escuta só em `127.0.0.1` de propósito (ver `server.js`).

## Endpoints

Cada linha legada (`lembretes`, `envios`) tem seus próprios endpoints e exige o header administrativo `X-Admin-API-Key: <sua chave>`. Para novas integrações, use os endpoints multi-cliente descritos abaixo.

- `GET /:linha/status` — status atual (`desconectado` | `conectando` | `aguardando_qr` | `conectado`), QR (data URL) quando aplicável, número conectado, erro, etc.
- `POST /:linha/reconectar` — força uma nova tentativa de conexão (reaproveita sessão salva se ainda for válida).
- `POST /:linha/desconectar` — desconecta de vez e apaga a sessão salva (próxima conexão pede QR novo).
- `POST /:linha/enviar` — body `{ telefone, texto, imagemBase64?, imagemMime?, imagemNome? }`.

## Vários softwares (multi-cliente)

A chave configurada em `WHATSAPP_API_KEY` é agora a **chave administrativa**. Use-a exclusivamente no header `X-Admin-API-Key` para criar, listar ou revogar integrações.

Crie um software com `POST /v1/clientes`, body `{ "id": "sistema-like", "nome": "Sistema Like" }`. A resposta devolve um `token` uma única vez. Entregue esse token somente ao software correspondente, que passa a chamar:

- `GET /v1/whatsapp/status`
- `POST /v1/whatsapp/reconectar`
- `POST /v1/whatsapp/desconectar`
- `POST /v1/whatsapp/enviar`

usando `X-API-Key: <token-do-software>`. A sessão é isolada em disco por cliente e o token não escolhe uma linha pela URL: ele só pode operar a própria conexão. Por padrão são permitidas até 10 conexões Chromium simultâneas; ajuste `WHATSAPP_MAX_CLIENTES` no `.env` conforme a memória disponível.

As rotas antigas `/:linha/*` continuam disponíveis para as sessões existentes, mas agora exigem `X-Admin-API-Key`; novas integrações devem usar `/v1/whatsapp`.
