import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { logError, logInfo } from './logger.js';

const sseSessions = new Map();

function safeCompareTokens(provided, expected) {
  if (!provided || !expected) return false;
  const hashA = crypto.createHash('sha256').update(String(provided)).digest();
  const hashB = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function applyMcpCorsHeaders(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-Id, X-Guardiao-Token'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

export function verifyMcpHttpAuth(req, urlObj, expectedToken) {
  if (!expectedToken) return false;

  const queryToken = urlObj.searchParams.get('token') || urlObj.searchParams.get('key');
  if (queryToken && safeCompareTokens(queryToken, expectedToken)) {
    return true;
  }

  const headerToken = req.headers['x-guardiao-token'];
  if (headerToken && safeCompareTokens(headerToken, expectedToken)) {
    return true;
  }

  const authHeader = req.headers.authorization || '';
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (safeCompareTokens(bearer, expectedToken)) {
      return true;
    }
  }

  return false;
}

function formatToolResult(result) {
  if (!result?.ok) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: result?.error || 'Ação bloqueada pelo Guardião WhatsApp.'
        }
      ]
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
}

export function createGuardMcpServerInstance(executeToolFn) {
  const server = new McpServer({
    name: 'whatsapp-guard',
    version: '1.0.0'
  });

  server.tool(
    'whatsapp_get_status',
    'Verifica se o programa Guardião WhatsApp está aberto, se a chave da IA está ativa e quantas conversas de trabalho estão autorizadas.',
    {},
    async () => formatToolResult(await executeToolFn('whatsapp_get_status', {}, 'Web/Cloud MCP'))
  );

  server.tool(
    'whatsapp_list_authorized_chats',
    'Lista apenas os Grupos de Trabalho marcados pelo funcionário e os Contatos que possuem a Tag autorizada (ex: [EMP], [CLIENTE]). Conversas privadas nunca aparecem aqui.',
    {},
    async () =>
      formatToolResult(await executeToolFn('whatsapp_list_authorized_chats', {}, 'Web/Cloud MCP'))
  );

  server.tool(
    'whatsapp_read_messages',
    'Lê o histórico de mensagens de um Grupo de Trabalho ou Contato autorizado pelo JID.',
    {
      jid: z
        .string()
        .describe('O JID da conversa autorizada (ex: 120363001@g.us ou 5511988881111@s.whatsapp.net)'),
      limit: z
        .number()
        .optional()
        .default(40)
        .describe('Quantidade máxima de mensagens para retornar (padrão: 40)')
    },
    async ({ jid, limit }) =>
      formatToolResult(await executeToolFn('whatsapp_read_messages', { jid, limit }, 'Web/Cloud MCP'))
  );

  server.tool(
    'whatsapp_search_messages',
    'Busca mensagens por palavra-chave ou assunto exclusivamente dentro das conversas de trabalho autorizadas.',
    {
      query: z.string().describe('Termo, palavra-chave ou nome para buscar nas mensagens autorizadas'),
      jid: z.string().optional().describe('Opcional: filtrar busca dentro de um JID específico'),
      limit: z.number().optional().default(30).describe('Quantidade máxima de resultados')
    },
    async ({ query, jid, limit }) =>
      formatToolResult(
        await executeToolFn('whatsapp_search_messages', { query, jid, limit }, 'Web/Cloud MCP')
      )
  );

  server.tool(
    'whatsapp_get_recent_activity',
    'Retorna as mensagens mais recentes de todas as conversas de trabalho autorizadas (ideal para resumir o que aconteceu no dia).',
    {
      limit: z.number().optional().default(30).describe('Quantidade de mensagens recentes (padrão: 30)')
    },
    async ({ limit }) =>
      formatToolResult(
        await executeToolFn('whatsapp_get_recent_activity', { limit }, 'Web/Cloud MCP')
      )
  );

  server.tool(
    'whatsapp_send_message',
    'Envia uma mensagem de WhatsApp passando pelas travas Anti-Banimento (só envia para conversas autorizadas, simula "Digitando...", respeita limite por hora e pede aprovação de 1 clique para contatos individuais se configurado).',
    {
      jid: z.string().describe('JID do grupo ou contato autorizado'),
      message: z.string().describe('Texto da mensagem a ser enviada')
    },
    async ({ jid, message }) =>
      formatToolResult(
        await executeToolFn('whatsapp_send_message', { jid, message }, 'Web/Cloud MCP')
      )
  );

  server.tool(
    'whatsapp_fetch_older_messages',
    'Solicita ao celular do usuário o histórico de mensagens mais antigas de uma conversa autorizada (ou de todas as conversas autorizadas se jid não for informado).',
    {
      jid: z.string().optional().describe('Opcional: JID específico de um grupo ou contato autorizado'),
      count: z
        .number()
        .optional()
        .default(50)
        .describe('Quantidade de mensagens anteriores por conversa (padrão: 50)')
    },
    async ({ jid, count }) =>
      formatToolResult(
        await executeToolFn('whatsapp_fetch_older_messages', { jid, count }, 'Web/Cloud MCP')
      )
  );

  server.tool(
    'whatsapp_list_labels',
    'Lista todas as Etiquetas e Listas personalizadas existentes no WhatsApp do usuário (ex: Clientes VIP, [EMP]) e as tags de trabalho ativas no Guardião.',
    {},
    async () =>
      formatToolResult(await executeToolFn('whatsapp_list_labels', {}, 'Web/Cloud MCP'))
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
      formatToolResult(
        await executeToolFn(
          'whatsapp_save_contact',
          { phoneOrJid, fullName, firstName, labels },
          'Web/Cloud MCP'
        )
      )
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
    async ({ contacts }) =>
      formatToolResult(
        await executeToolFn('whatsapp_save_contacts_batch', { contacts }, 'Web/Cloud MCP')
      )
  );

  return server;
}

/**
 * Trata requisições Streamable HTTP (/mcp) para SuperGrok, Grok Bot, Gemini Enterprise e ChatGPT Web.
 * Usa modo stateless + JSON response para máxima compatibilidade com túneis Cloudflare e pods remotos.
 */
export async function handleStreamableMcpRequest(req, res, urlObj, expectedToken, executeToolFn) {
  applyMcpCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!verifyMcpHttpAuth(req, urlObj, expectedToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Não autorizado: Token de segurança do Guardião WhatsApp ausente ou inválido.'
        },
        id: null
      })
    );
    return;
  }

  // Alguns conectores de navegador verificam GET /mcp sem header SSE para testar saúde do endpoint
  if (req.method === 'GET' && !String(req.headers.accept || '').includes('text/event-stream')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        name: 'whatsapp-guard',
        version: '1.0.0',
        transport: 'streamable-http'
      })
    );
    return;
  }

  // Normaliza Accept em POST para evitar 406 em clientes Cloud que enviam apenas application/json ou */*
  if (req.method === 'POST') {
    const currentAccept = String(req.headers.accept || '');
    if (!currentAccept.includes('application/json') || !currentAccept.includes('text/event-stream')) {
      req.headers.accept = 'application/json, text/event-stream';
    }
    const rawIndex = Array.isArray(req.rawHeaders)
      ? req.rawHeaders.findIndex((h) => h.toLowerCase() === 'accept')
      : -1;
    if (rawIndex >= 0 && req.rawHeaders[rawIndex + 1]) {
      req.rawHeaders[rawIndex + 1] = 'application/json, text/event-stream';
    }
  }

  const mcpServer = createGuardMcpServerInstance(executeToolFn);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    logError('mcp-http', 'Erro ao processar requisição Streamable HTTP MCP', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Erro interno no servidor MCP Guardião.' },
          id: null
        })
      );
    }
  }
}

/**
 * Compatibilidade adicional SSE (/sse + /messages) para clientes MCP baseados em SSE clássico.
 */
export async function handleLegacySseConnect(req, res, urlObj, expectedToken, executeToolFn) {
  applyMcpCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!verifyMcpHttpAuth(req, urlObj, expectedToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Token inválido.' }));
    return;
  }

  const tokenParam = urlObj.searchParams.get('token') || '';
  const messagesEndpoint = tokenParam
    ? `/messages?token=${encodeURIComponent(tokenParam)}`
    : '/messages';

  const mcpServer = createGuardMcpServerInstance(executeToolFn);
  const transport = new SSEServerTransport(messagesEndpoint, res);
  const sessionId = transport.sessionId;
  sseSessions.set(sessionId, { transport, mcpServer });

  res.on('close', () => {
    sseSessions.delete(sessionId);
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  });

  try {
    logInfo('mcp-sse', 'Nova sessão SSE conectada', { sessionId });
    await mcpServer.connect(transport);
  } catch (err) {
    sseSessions.delete(sessionId);
    logError('mcp-sse', 'Falha ao iniciar transporte SSE', err);
  }
}

export async function handleLegacySseMessage(req, res, urlObj, expectedToken) {
  applyMcpCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!verifyMcpHttpAuth(req, urlObj, expectedToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Token inválido.' }));
    return;
  }

  const sessionId = urlObj.searchParams.get('sessionId');
  const session = sessionId ? sseSessions.get(sessionId) : null;
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Sessão SSE não encontrada.' }));
    return;
  }

  await session.transport.handlePostMessage(req, res);
}

export function closeAllRemoteMcpSessions() {
  for (const [, session] of sseSessions) {
    session.transport.close().catch(() => {});
    session.mcpServer.close().catch(() => {});
  }
  sseSessions.clear();
}
