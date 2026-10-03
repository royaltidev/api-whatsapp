# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Administradores técnicos que mantêm conexões WhatsApp usadas por vários softwares.

## Product Purpose

Serviço HTTP para conectar sessões independentes de WhatsApp e enviar mensagens a partir de sistemas clientes.

## Positioning

Cada token de software fica limitado à sua própria sessão WhatsApp; a administração de integrações e processos ocorre fora desse escopo.

## Operating Context

O administrador opera o serviço remotamente em uma VPS, acompanhando QR codes, estados de conexão e processos Chromium.

## Capabilities and Constraints

- API Node.js com whatsapp-web.js e uma sessão Chromium por conexão.
- Integrações multi-cliente isoladas por token e por diretório de sessão.
- Painel deve ter ativação no primeiro acesso, seguida de autenticação por usuário e senha.
- Após ativado, o endpoint de criação do primeiro usuário deve ficar inacessível.

## Evidence on Hand

Os estados reais disponíveis são desconectado, conectando, aguardando QR e conectado. Não há métricas históricas ou dados comerciais a apresentar.

## Product Principles

- Isolamento entre softwares é inegociável.
- Ações destrutivas devem ser explícitas e recuperáveis quando possível.
- O estado operacional deve ser compreensível em poucos segundos.
