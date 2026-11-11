import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addAuditLog,
  clearChatHistoryFromAI,
  deleteMessageFromAI,
  getAuditLogs,
  getAuthorizedMessages,
  getDirectoryChats,
  getOutboxStats,
  getRecentAuthorizedMessages,
  getRecentContactSaveItems,
  getRecentOutboxItems,
  getSettings,
  ingestFilteredMessage,
  isChatAuthorized,
  rotateMcpHttpToken,
  searchAuthorizedMessages,
  setChatExplicitPermission,
  updateSettings,
  upsertDirectoryChat
} from './db.js';
import {
  getAIClientsStatus,
  installMCPInAllDetected,
  installMCPInClient,
  restartAIClient,
  testMcpBridgeHandshake,
  uninstallMCPFromClient
} from './ai-installer.js';
import {
  closeAllRemoteMcpSessions,
  handleLegacySseConnect,
  handleLegacySseMessage,
  handleStreamableMcpRequest
} from './mcp-http-gateway.js';
import { tunnelService } from './tunnel-service.js';
import { whatsappService } from './whatsapp-service.js';
import {
  LOG_FILE_PATH,
  installProcessLogHooks,
  logError,
  logInfo,
  readRecentLogLines
} from './logger.js';

installProcessLogHooks('server');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export const PORT = Number(process.env.WHATSAPP_GUARD_PORT || 3847);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('Payload muito grande'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Executa as ferramentas chamadas pela IA (via mcp-bridge.js)
 * Registra tudo no painel de Auditoria ao vivo e aplica a Chave Geral (Kill-Switch).
 */
async function handleMCPToolExecution(toolName, args = {}, sourceLabel = 'IA Local') {
  const settings = getSettings();
  const tagPrefix = sourceLabel === 'Web/Cloud MCP' ? '[SuperGrok / Web] ' : '';

  if (!settings.aiEnabled) {
    addAuditLog({
      action: toolName,
      target: args.jid || args.query || 'Geral',
      details: `${tagPrefix}Acesso negado: O funcionário pausou a Chave Geral da IA no aplicativo.`,
      blocked: true
    });
    return {
      ok: false,
      error:
        '🔒 A Chave Geral da IA está PAUSADA pelo funcionário no aplicativo Guardião WhatsApp. Peça ao usuário para clicar em "IA Ativa" na janela do programa.'
    };
  }

  switch (toolName) {
    case 'whatsapp_get_status': {
      const wa = whatsappService.getStatus();
      const chats = getDirectoryChats().filter((c) => c.isAuthorized);
      addAuditLog({
        action: 'consultar_status',
        target: 'Sistema',
        details: `${tagPrefix}IA verificou status (${chats.length} conversas autorizadas disponíveis)`
      });
      return {
        ok: true,
        data: {
          appOpen: true,
          aiEnabled: settings.aiEnabled,
          whatsappConnection: wa.connectionStatus,
          connectedAccount: wa.connectedUser,
          authorizedChatsCount: chats.length,
          allowedTags: settings.allowedTags,
          availableWhatsAppLabels: whatsappService.getAvailableLabels().map((l) => l.name),
          antiBanPolicy: {
            maxMessagesPerHour: settings.maxMessagesPerHour,
            requireApprovalForContacts: settings.requireApprovalForContacts,
            requireApprovalForGroups: settings.requireApprovalForGroups,
            requireApprovalForContactsSave: settings.requireApprovalForContactsSave
          }
        }
      };
    }

    case 'whatsapp_list_authorized_chats': {
      const allAuthorized = getDirectoryChats().filter((c) => c.isAuthorized);
      addAuditLog({
        action: 'listar_conversas_autorizadas',
        target: `${allAuthorized.length} conversas`,
        details: `${tagPrefix}IA listou os grupos marcados e contatos com Tag de trabalho`
      });
      return {
        ok: true,
        data: allAuthorized.map((c) => ({
          jid: c.jid,
          name: c.name,
          labels: c.labels || [],
          isSavedContact: !c.isGroup && c.nameSource === 'contact' && !c.name.startsWith('+'),
          type: c.isGroup ? 'grupo_trabalho' : 'contato_com_tag',
          rule: c.explicitlyAllowed
            ? 'Marcado manualmente'
            : c.matchedByLabel
            ? `Lista/Etiqueta "${c.matchedLabelName}" no WhatsApp`
            : 'Tag no nome do contato',
          storedMessagesCount: c.storedMessagesCount
        }))
      };
    }

    case 'whatsapp_read_messages': {
      const { jid, limit = 40 } = args;
      if (!jid) {
        return { ok: false, error: 'Informe o parâmetro jid da conversa.' };
      }
      const auth = isChatAuthorized(jid);
      if (!auth.allowed) {
        addAuditLog({
          action: 'ler_mensagens (Bloqueado)',
          target: jid,
          details: `${tagPrefix}IA tentou ler conversa não autorizada`,
          blocked: true
        });
        return {
          ok: false,
          error: `🔒 Acesso negado: A conversa "${jid}" é privada e não está na lista de grupos/tags permitidos.`
        };
      }

      const messages = getAuthorizedMessages(jid, limit);
      addAuditLog({
        action: 'ler_mensagens',
        target: auth.name || jid,
        details: `${tagPrefix}IA leu ${messages.length} mensagem(ns) de "${auth.name || jid}"`
      });
      return {
        ok: true,
        data: {
          jid,
          chatName: auth.name || jid,
          count: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            sender: m.sender_name,
            fromMe: m.from_me === 1,
            text: m.content,
            time: new Date(m.timestamp).toLocaleString('pt-BR')
          }))
        }
      };
    }

    case 'whatsapp_search_messages': {
      const { query = '', jid = null, limit = 30 } = args;
      const results = searchAuthorizedMessages(query, jid, limit);
      addAuditLog({
        action: 'buscar_mensagens',
        target: query ? `Termo: "${query}"` : 'Recentes',
        details: `${tagPrefix}Retornou ${results.length} mensagem(ns) das conversas de trabalho`
      });
      return {
        ok: true,
        data: {
          query,
          count: results.length,
          results: results.map((m) => ({
            jid: m.jid,
            chatName: m.chat_name,
            sender: m.sender_name,
            fromMe: m.from_me === 1,
            text: m.content,
            time: new Date(m.timestamp).toLocaleString('pt-BR')
          }))
        }
      };
    }

    case 'whatsapp_get_recent_activity': {
      const { limit = 30 } = args;
      const messages = getRecentAuthorizedMessages(limit);
      addAuditLog({
        action: 'resumo_recente',
        target: 'Todas as conversas autorizadas',
        details: `${tagPrefix}IA consultou as últimas ${messages.length} mensagens de trabalho`
      });
      return {
        ok: true,
        data: messages.map((m) => ({
          jid: m.jid,
          chatName: m.chat_name,
          sender: m.sender_name,
          fromMe: m.from_me === 1,
          text: m.content,
          time: new Date(m.timestamp).toLocaleString('pt-BR')
        }))
      };
    }

    case 'whatsapp_send_message': {
      const { jid, message } = args;
      try {
        const result = whatsappService.queueMessageFromAI({ jid, content: message });
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case 'whatsapp_fetch_older_messages': {
      const { jid = null, count = 50 } = args;
      try {
        const res = await whatsappService.fetchHistoryForAuthorizedChats(count, jid);
        if (!res.ok) return { ok: false, error: res.message };
        return { ok: true, data: res };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case 'whatsapp_list_labels': {
      const labels = whatsappService.getAvailableLabels();
      addAuditLog({
        action: 'listar_etiquetas',
        target: `${labels.length} listas`,
        details: `${tagPrefix}IA consultou as etiquetas e listas disponíveis no WhatsApp`
      });
      return {
        ok: true,
        data: {
          whatsappLabels: labels,
          guardiaoAllowedTags: settings.allowedTags,
          requireApprovalForContactsSave: settings.requireApprovalForContactsSave
        }
      };
    }

    case 'whatsapp_save_contact': {
      const { phoneOrJid, fullName, firstName = '', labels = [] } = args;
      try {
        const actor = sourceLabel === 'Web/Cloud MCP' ? 'IA Web (MCP)' : 'IA Local (MCP)';
        const result = await whatsappService.requestContactSaveFromAI({
          phoneOrJid,
          fullName,
          firstName,
          labels,
          actor
        });
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case 'whatsapp_save_contacts_batch': {
      const { contacts = [] } = args;
      try {
        const actor = sourceLabel === 'Web/Cloud MCP' ? 'IA Web (MCP)' : 'IA Local (MCP)';
        const result = await whatsappService.requestContactSaveBatchFromAI(contacts, actor);
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    default:
      return { ok: false, error: `Ferramenta desconhecida: ${toolName}` };
  }
}

export function startGuardServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const pathname = url.pathname;

      // --- ENDPOINTS MCP STREAMABLE HTTP & SSE (SUPERGROK, GROK BOT, GEMINI WEB, CHATGPT) ---
      if (pathname === '/mcp') {
        const expectedToken = getSettings().mcpHttpToken;
        return await handleStreamableMcpRequest(
          req,
          res,
          url,
          expectedToken,
          handleMCPToolExecution
        );
      }

      if (pathname === '/sse') {
        const expectedToken = getSettings().mcpHttpToken;
        return await handleLegacySseConnect(req, res, url, expectedToken, handleMCPToolExecution);
      }

      if (pathname === '/messages') {
        const expectedToken = getSettings().mcpHttpToken;
        return await handleLegacySseMessage(req, res, url, expectedToken);
      }

      // --- ROTAS DA API DO PROGRAMA DESKTOP ---
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, pid: process.pid });
      }

      if (pathname === '/api/logs' && req.method === 'GET') {
        return sendJson(res, 200, {
          logPath: LOG_FILE_PATH,
          lines: readRecentLogLines(150)
        });
      }

      if (pathname === '/api/logs/open' && req.method === 'POST') {
        logInfo('server', 'Usuário abriu arquivo de log pela interface');
        if (process.platform === 'win32') {
          exec(`notepad.exe "${LOG_FILE_PATH}"`);
        } else if (process.platform === 'darwin') {
          exec(`open "${LOG_FILE_PATH}"`);
        } else {
          exec(`xdg-open "${LOG_FILE_PATH}"`);
        }
        return sendJson(res, 200, { ok: true, logPath: LOG_FILE_PATH });
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, {
          whatsapp: whatsappService.getStatus(),
          settings: getSettings(),
          chats: getDirectoryChats(),
          outbox: getRecentOutboxItems(25),
          contactSaves: getRecentContactSaveItems(35),
          availableLabels: whatsappService.getAvailableLabels(),
          outboxStats: getOutboxStats(),
          auditLogs: getAuditLogs(40),
          aiClients: getAIClientsStatus(),
          tunnel: tunnelService.getStatus(PORT)
        });
      }

      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        const updated = updateSettings(body);
        return sendJson(res, 200, { settings: updated, chats: getDirectoryChats() });
      }

      if (pathname === '/api/chats/permission' && req.method === 'POST') {
        const { jid, allowed } = await readBody(req);
        const chats = setChatExplicitPermission(jid, Boolean(allowed));
        if (allowed) {
          whatsappService.autoFetchIfEmpty(jid);
        }
        return sendJson(res, 200, { chats });
      }

      if (pathname === '/api/chats/add-manual' && req.method === 'POST') {
        const { jidOrPhone, name, isGroup, explicitlyAllowed } = await readBody(req);
        const clean = (jidOrPhone || '').trim();
        if (!clean) return sendJson(res, 400, { error: 'Informe o número ou ID do grupo' });
        const finalJid = clean.includes('@')
          ? clean
          : `${clean.replace(/\D/g, '')}@${isGroup ? 'g.us' : 's.whatsapp.net'}`;
        upsertDirectoryChat(finalJid, name || finalJid, Boolean(isGroup));
        if (explicitlyAllowed) {
          setChatExplicitPermission(finalJid, true);
        }
        return sendJson(res, 200, { chats: getDirectoryChats() });
      }

      if (pathname === '/api/messages' && req.method === 'GET') {
        const jid = url.searchParams.get('jid');
        const messages = jid ? getAuthorizedMessages(jid, 100) : getRecentAuthorizedMessages(60);
        return sendJson(res, 200, { messages });
      }

      if (pathname === '/api/messages/simulate-incoming' && req.method === 'POST') {
        const { jid, chatName, senderName, content } = await readBody(req);
        const result = ingestFilteredMessage({
          id: `sim_${Date.now()}`,
          jid,
          chatName,
          senderName,
          fromMe: false,
          content,
          timestamp: Date.now()
        });
        if (result.stored) {
          whatsappService.sessionStats.storedMessages += 1;
        } else {
          whatsappService.sessionStats.discardedPrivateMessages += 1;
        }
        return sendJson(res, 200, { result });
      }

      if (pathname === '/api/messages/delete' && req.method === 'POST') {
        const { id } = await readBody(req);
        deleteMessageFromAI(id);
        return sendJson(res, 200, { deleted: true });
      }

      if (pathname === '/api/messages/clear' && req.method === 'POST') {
        const { jid, lastHoursOnly } = await readBody(req);
        const removed = clearChatHistoryFromAI(jid, lastHoursOnly);
        return sendJson(res, 200, { removed });
      }

      if (pathname === '/api/outbox/approve' && req.method === 'POST') {
        const { id, content } = await readBody(req);
        const item = whatsappService.approveOutboxMessage(Number(id), content);
        return sendJson(res, 200, { item });
      }

      if (pathname === '/api/outbox/reject' && req.method === 'POST') {
        const { id } = await readBody(req);
        const item = whatsappService.rejectOutboxMessage(Number(id));
        return sendJson(res, 200, { item });
      }

      if (pathname === '/api/contacts-queue/approve' && req.method === 'POST') {
        const { id, fullName = null, labels = null, all = false } = await readBody(req);
        try {
          if (all) {
            const batchRes = await whatsappService.approveAllPendingContactSaves();
            return sendJson(res, 200, batchRes);
          }
          const item = await whatsappService.approveContactSave(Number(id), { fullName, labels });
          return sendJson(res, 200, { ok: true, item });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: err.message });
        }
      }

      if (pathname === '/api/contacts-queue/reject' && req.method === 'POST') {
        const { id, all = false } = await readBody(req);
        if (all) {
          const resAll = whatsappService.rejectAllPendingContacts();
          return sendJson(res, 200, { ok: true, ...resAll });
        }
        const item = whatsappService.rejectContactSave(Number(id));
        return sendJson(res, 200, { ok: true, item });
      }

      if (pathname === '/api/whatsapp/connect' && req.method === 'POST') {
        const body = await readBody(req);
        const status = await whatsappService.startConnection(Boolean(body?.forceFresh));
        return sendJson(res, 200, { whatsapp: status });
      }

      if (pathname === '/api/whatsapp/demo' && req.method === 'POST') {
        const status = whatsappService.activateDemoMode();
        return sendJson(res, 200, { whatsapp: status });
      }

      if (pathname === '/api/whatsapp/disconnect' && req.method === 'POST') {
        const { logout } = await readBody(req);
        const status = await whatsappService.disconnect(Boolean(logout));
        return sendJson(res, 200, { whatsapp: status });
      }

      if (pathname === '/api/whatsapp/fetch-history' && req.method === 'POST') {
        const { jid = null, count = 50 } = await readBody(req);
        const result = await whatsappService.fetchHistoryForAuthorizedChats(Number(count) || 50, jid || null);
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/whatsapp/sync-contacts' && req.method === 'POST') {
        const result = await whatsappService.syncContactsAndLabelsFromAppState({ silent: false });
        return sendJson(res, 200, { ...result, chats: getDirectoryChats() });
      }

      if (pathname === '/api/ai-clients/install' && req.method === 'POST') {
        const { clientId, all } = await readBody(req);
        if (all) {
          installMCPInAllDetected();
        } else {
          installMCPInClient(clientId);
        }
        return sendJson(res, 200, { aiClients: getAIClientsStatus() });
      }

      if (pathname === '/api/ai-clients/uninstall' && req.method === 'POST') {
        const { clientId } = await readBody(req);
        uninstallMCPFromClient(clientId);
        return sendJson(res, 200, { aiClients: getAIClientsStatus() });
      }

      if (pathname === '/api/ai-clients/test' && req.method === 'POST') {
        const diag = await testMcpBridgeHandshake();
        return sendJson(res, 200, diag);
      }

      if (pathname === '/api/ai-clients/restart' && req.method === 'POST') {
        const { clientId } = await readBody(req);
        const result = await restartAIClient(clientId);
        return sendJson(res, 200, { ...result, aiClients: getAIClientsStatus() });
      }

      if (pathname === '/api/tunnel/toggle' && req.method === 'POST') {
        const { enabled } = await readBody(req);
        if (enabled) {
          const tunnel = await tunnelService.start(PORT);
          return sendJson(res, 200, { tunnel });
        }
        const tunnel = tunnelService.stop(true, PORT);
        return sendJson(res, 200, { tunnel });
      }

      if (pathname === '/api/tunnel/config' && req.method === 'POST') {
        const { customTunnelUrl = '', customTunnelToken = '' } = await readBody(req);
        updateSettings({
          customTunnelUrl: String(customTunnelUrl || '').trim(),
          customTunnelToken: String(customTunnelToken || '').trim()
        });
        if (tunnelService.status === 'running') {
          tunnelService.stop(false, PORT);
          const tunnel = await tunnelService.start(PORT);
          return sendJson(res, 200, { tunnel });
        }
        return sendJson(res, 200, { tunnel: tunnelService.getStatus(PORT) });
      }

      if (pathname === '/api/tunnel/rotate-token' && req.method === 'POST') {
        rotateMcpHttpToken();
        return sendJson(res, 200, { tunnel: tunnelService.getStatus(PORT) });
      }

      if (pathname === '/api/open-external' && req.method === 'POST') {
        const { url: targetUrl } = await readBody(req);
        if (typeof targetUrl === 'string' && targetUrl.startsWith('https://')) {
          if (process.platform === 'win32') {
            exec(`start "" "${targetUrl.replace(/"/g, '')}"`);
          } else if (process.platform === 'darwin') {
            exec(`open "${targetUrl.replace(/"/g, '')}"`);
          } else {
            exec(`xdg-open "${targetUrl.replace(/"/g, '')}"`);
          }
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 400, { error: 'URL externa inválida.' });
      }

      // --- ROTA INTERNA CHAMADA PELO MENSAGEIRO OCO (MCP BRIDGE) ---
      if (pathname === '/api/mcp/call' && req.method === 'POST') {
        const { tool, args } = await readBody(req);
        const result = await handleMCPToolExecution(tool, args || {});
        return sendJson(res, 200, result);
      }

      // --- ARQUIVOS ESTÁTICOS DA INTERFACE DESKTOP ---
      const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      sendJson(res, 404, { error: 'Não encontrado' });
    } catch (err) {
      logError('server', 'Erro na requisição HTTP', err);
      sendJson(res, 500, { error: err?.message || 'Erro interno no servidor local' });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    logInfo('server', 'Servidor Guardião iniciado', { port: PORT, pid: process.pid });
    console.log(`🛡️ Guardião WhatsApp MCP rodando em http://127.0.0.1:${PORT}`);
    if (getSettings().webTunnelEnabled) {
      tunnelService.start(PORT).catch(() => {});
    }
    if (process.argv.includes('--open-window')) {
      openStandaloneAppWindow(`http://127.0.0.1:${PORT}`);
    }
  });

  if (process.env.GUARDIAO_CHILD_MODE === '1') {
    process.stdin.resume();
    process.stdin.on('close', () => {
      logInfo('server', 'Janela principal fechada; desconectando e encerrando processo filho');
      tunnelService.stop(false, PORT);
      closeAllRemoteMcpSessions();
      whatsappService
        .disconnect(false)
        .catch(() => {})
        .finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 900);
    });
  }

  return server;
}

function openStandaloneAppWindow(url) {
  if (process.platform === 'win32') {
    // Tenta abrir como janela de aplicativo dedicada no Edge ou Chrome
    exec(`start msedge --app="${url}" || start chrome --app="${url}" || start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

// Se executado diretamente via node src/main-server.js
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startGuardServer();
}
