#!/usr/bin/env node
/**
 * O "MENSAGEIRO OCO" (Hollow MCP Bridge)
 * ----------------------------------------------------------------------------
 * Este script é o único registrado nos clientes de IA (Claude, Cursor, Antigravity, Codex).
 * Ele NÃO tem acesso direto ao WhatsApp nem ao banco de dados SQLite.
 * Ele apenas repassa os comandos da IA para a janela aberta do programa Guardião (http://127.0.0.1:3847).
 *
 * Se o funcionário FECHAR o programa Guardião, este mensageiro avisa a IA imediatamente
 * que o programa está fechado — garantindo 100% de controle físico para o funcionário.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GUARD_URL = process.env.WHATSAPP_GUARD_URL || 'http://127.0.0.1:3847';

async function callGuardApp(tool, args = {}) {
  try {
    const response = await fetch(`${GUARD_URL}/api/mcp/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(45000)
    });

    if (!response.ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Erro ao comunicar com o aplicativo Guardião WhatsApp (HTTP ${response.status}).`
          }
        ]
      };
    }

    const result = await response.json();
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: result.error || 'Ação bloqueada pelo Guardião WhatsApp.' }]
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.data, null, 2)
        }
      ]
    };
  } catch {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            '🔒 O programa "Guardião WhatsApp MCP" está FECHADO no computador do usuário.\n' +
            'Por segurança e privacidade, o acesso ao WhatsApp só funciona enquanto a janela do aplicativo estiver aberta.\n' +
            'Peça ao usuário para abrir o aplicativo "Guardião WhatsApp" na área de trabalho se quiser consultar ou enviar mensagens.'
        }
      ]
    };
  }
}

const server = new McpServer({
  name: 'whatsapp-guard',
  version: '1.0.0'
});

server.tool(
  'whatsapp_get_status',
  'Verifica se o programa Guardião WhatsApp está aberto, se a chave da IA está ativa e quantas conversas de trabalho estão autorizadas.',
  {},
  async () => callGuardApp('whatsapp_get_status', {})
);

server.tool(
  'whatsapp_list_authorized_chats',
  'Lista apenas os Grupos de Trabalho marcados pelo funcionário e os Contatos que possuem a Tag autorizada (ex: [EMP], #emp). Conversas privadas nunca aparecem aqui.',
  {},
  async () => callGuardApp('whatsapp_list_authorized_chats', {})
);

server.tool(
  'whatsapp_read_messages',
  'Lê o histórico de mensagens de um Grupo de Trabalho ou Contato autorizado pelo JID.',
  {
    jid: z.string().describe('O JID da conversa autorizada (ex: 120363001@g.us ou 5511988881111@s.whatsapp.net)'),
    limit: z.number().optional().default(40).describe('Quantidade máxima de mensagens para retornar (padrão: 40)')
  },
  async ({ jid, limit }) => callGuardApp('whatsapp_read_messages', { jid, limit })
);

server.tool(
  'whatsapp_search_messages',
  'Busca mensagens por palavra-chave ou assunto exclusivamente dentro das conversas de trabalho autorizadas.',
  {
    query: z.string().describe('Termo, palavra-chave ou nome para buscar nas mensagens autorizadas'),
    jid: z.string().optional().describe('Opcional: filtrar busca dentro de um JID específico'),
    limit: z.number().optional().default(30).describe('Quantidade máxima de resultados')
  },
  async ({ query, jid, limit }) => callGuardApp('whatsapp_search_messages', { query, jid, limit })
);

server.tool(
  'whatsapp_get_recent_activity',
  'Retorna as mensagens mais recentes de todas as conversas de trabalho autorizadas (ideal para resumir o que aconteceu no dia).',
  {
    limit: z.number().optional().default(30).describe('Quantidade de mensagens recentes (padrão: 30)')
  },
  async ({ limit }) => callGuardApp('whatsapp_get_recent_activity', { limit })
);

server.tool(
  'whatsapp_send_message',
  'Envia uma mensagem de WhatsApp passando pelas travas Anti-Banimento (só envia para conversas autorizadas, simula "Digitando...", respeita limite por hora e pede aprovação de 1 clique para contatos individuais se configurado).',
  {
    jid: z.string().describe('JID do grupo ou contato autorizado'),
    message: z.string().describe('Texto da mensagem a ser enviada')
  },
  async ({ jid, message }) => callGuardApp('whatsapp_send_message', { jid, message })
);

server.tool(
  'whatsapp_fetch_older_messages',
  'Solicita ao celular do usuário o histórico de mensagens mais antigas de uma conversa autorizada (ou de todas as conversas autorizadas se jid não for informado).',
  {
    jid: z.string().optional().describe('Opcional: JID específico de um grupo ou contato autorizado'),
    count: z.number().optional().default(50).describe('Quantidade de mensagens anteriores por conversa (padrão: 50)')
  },
  async ({ jid, count }) => callGuardApp('whatsapp_fetch_older_messages', { jid, count })
);

server.tool(
  'whatsapp_list_labels',
  'Lista todas as Etiquetas e Listas personalizadas existentes no WhatsApp do usuário (ex: Clientes VIP, [EMP]) e as tags de trabalho ativas no Guardião.',
  {},
  async () => callGuardApp('whatsapp_list_labels', {})
);

server.tool(
  'whatsapp_save_contact',
  'Salva ou atualiza um contato comercial diretamente na agenda do WhatsApp + agenda nativa do celular e opcionalmente vincula a listas/etiquetas do WhatsApp. Nunca sobrescreve contatos pessoais privados.',
  {
    phoneOrJid: z
      .string()
      .describe('JID do contato (ex: 5511999990000@s.whatsapp.net) ou telefone com DDI (ex: +5511999990000)'),
    fullName: z
      .string()
      .describe('Nome completo para salvar na agenda (ex: "Ana Souza [Arquiteta] [EMP]"). Inclua a tag de trabalho se desejar mantê-la no nome.'),
    firstName: z
      .string()
      .optional()
      .describe('Opcional: primeiro nome do contato (ex: "Ana"). Se omitido, é extraído automaticamente.'),
    labels: z
      .array(z.string())
      .optional()
      .describe('Opcional: nomes de listas/etiquetas existentes no WhatsApp para vincular ao contato (ex: ["Clientes VIP", "[EMP]"])')
  },
  async ({ phoneOrJid, fullName, firstName, labels }) =>
    callGuardApp('whatsapp_save_contact', { phoneOrJid, fullName, firstName, labels })
);

server.tool(
  'whatsapp_save_contacts_batch',
  'Salva ou atualiza até 30 contatos comerciais de uma só vez na agenda do WhatsApp + Celular (ideal após ler conversas não salvas de uma lista como Clientes VIP e identificar o nome de cada cliente).',
  {
    contacts: z
      .array(
        z.object({
          phoneOrJid: z.string().describe('JID ou telefone com DDI (ex: 5511999990000@s.whatsapp.net)'),
          fullName: z.string().describe('Nome completo para salvar na agenda (ex: "Ana Souza [EMP]")'),
          firstName: z.string().optional().describe('Opcional: primeiro nome'),
          labels: z.array(z.string()).optional().describe('Opcional: listas/etiquetas do WhatsApp')
        })
      )
      .min(1)
      .max(30)
      .describe('Lista de contatos comerciais para salvar na agenda')
  },
  async ({ contacts }) => callGuardApp('whatsapp_save_contacts_batch', { contacts })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Erro ao iniciar MCP Bridge:', err);
  process.exit(1);
});
