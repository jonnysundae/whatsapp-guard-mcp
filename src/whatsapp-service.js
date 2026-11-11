import makeWASocket, {
  ALL_WA_PATCH_NAMES,
  Browsers,
  DisconnectReason,
  S_WHATSAPP_NET,
  aesDecrypt,
  decodePatches,
  decodeSyncdSnapshot,
  downloadExternalPatch,
  downloadHistory,
  encodeSyncdPatch,
  extractSyncdPatches,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  getHistoryMsg,
  hkdf,
  hmacSign,
  jidNormalizedUser,
  LT_HASH_ANTI_TAMPERING,
  newLTHashState,
  proto,
  toNumber,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR,
  addAuditLog,
  clearDemoData,
  enqueueContactSave,
  enqueueOutboxMessage,
  extractFirstNameFromFullName,
  getChatBasicInfo,
  getContactSaveItemById,
  getDirectoryChats,
  getHistoryCursorForChat,
  getNextQueuedOutboxItem,
  getPendingContactSaveItems,
  getRecentOutboxItems,
  getSentMessagesLastHour,
  getSettings,
  getWhatsAppLabelsCatalog,
  ingestFilteredMessage,
  isChatAuthorized,
  mergeLidIntoPhoneChat,
  normalizeChatJid,
  rejectAllPendingContactSaves,
  replaceAllChatLabelsFromSync,
  resolveCanonicalJid,
  runInTransaction,
  saveWhatsAppLabelsCatalog,
  setChatExplicitPermission,
  setChatLabels,
  updateChatLatestAnchor,
  updateContactSaveItem,
  updateOutboxItem,
  updateSingleChatLabel,
  upsertDirectoryChat,
  validateContactSavePermission
} from './db.js';
import { logError, logInfo, logWarn } from './logger.js';

const AUTH_DIR = path.join(DATA_DIR, 'wa_auth');

const logger = pino({ level: 'silent' });

class WhatsAppGuardService {
  constructor() {
    this.sock = null;
    this.authState = null;
    this.connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'demo_mode'
    this.qrDataUrl = null;
    this.connectedUser = null;
    this.pairingMessage = null;
    this.lastError = null;
    this.manualDisconnect = false;
    this.reconnectTimer = null;
    this.appStateSyncTimer = null;
    this.isSyncingAppState = false;
    this.hasCompletedAppStateSync = false;
    this.credsSaveChain = Promise.resolve();
    this.appPatchChain = Promise.resolve();
    this.lidMap = new Map(); // lidJid -> { jid, name }
    this.labelNamesById = new Map(); // labelId -> labelName
    try {
      for (const lbl of getWhatsAppLabelsCatalog()) {
        this.labelNamesById.set(String(lbl.id), String(lbl.name));
      }
    } catch {
      // ignora na primeira inicialização
    }
    this.sessionStats = {
      storedMessages: 0,
      discardedPrivateMessages: 0
    };
    this.historySyncStatus = {
      active: false,
      message: '',
      updatedAt: 0
    };
    this.isProcessingQueue = false;
    this.lastSentTimestamp = 0;
    this.lastSentMonotonic = 0;
    this.currentTargetGapMs = 0;
    this.reconnectAttempts = 0;
    this.lastGroupsFetchAt = 0;
    this.lastFullAppStateSyncAt = 0;

    // Garante que resquícios de modo demonstração anterior nunca fiquem presos no banco
    try {
      clearDemoData();
    } catch {
      // ignora
    }

    // Se já houver uma sessão pareada anteriormente, reconecta sozinho ao abrir o programa
    this._autoResumeIfPaired();

    // Loop da fila Anti-Banimento
    this.queueInterval = setInterval(() => {
      this.processOutboxQueue().catch(() => {});
    }, 3000);
  }

  _autoResumeIfPaired() {
    try {
      const credsFile = path.join(AUTH_DIR, 'creds.json');
      if (!fs.existsSync(credsFile)) return;
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      if (creds?.me?.id) {
        this.startConnection(false).catch(() => {});
      } else {
        this.clearAuthFolder();
      }
    } catch {
      this.clearAuthFolder();
    }
  }

  _hasAnyAppStateSyncKey() {
    try {
      if (!fs.existsSync(AUTH_DIR)) return false;
      return fs.readdirSync(AUTH_DIR).some((f) => f.startsWith('app-state-sync-key-'));
    } catch {
      return false;
    }
  }

  getStatus() {
    return {
      connectionStatus: this.connectionStatus,
      qrDataUrl: this.qrDataUrl,
      connectedUser: this.connectedUser,
      pairingMessage: this.pairingMessage,
      lastError: this.lastError,
      sessionStats: this.sessionStats,
      historySyncStatus: this.historySyncStatus,
      isSyncingContacts: this.isSyncingAppState,
      lastSentTimestamp: this.lastSentTimestamp
    };
  }

  _disposeSocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.appStateSyncTimer) {
      clearTimeout(this.appStateSyncTimer);
      this.appStateSyncTimer = null;
    }
    if (this.sock) {
      const old = this.sock;
      this.sock = null;
      try {
        old.ev.removeAllListeners();
        old.end(undefined);
      } catch {
        // ignora
      }
    }
  }

  scheduleAppStateSync(delayMs = 1000, { force = false } = {}) {
    if (force) {
      this._pendingForceAppStateSync = true;
    }
    if (this.appStateSyncTimer) {
      clearTimeout(this.appStateSyncTimer);
    }
    this.appStateSyncTimer = setTimeout(() => {
      this.appStateSyncTimer = null;
      const useForce = Boolean(this._pendingForceAppStateSync);
      this._pendingForceAppStateSync = false;
      this.syncContactsAndLabelsFromAppState({ silent: true, force: useForce }).catch(() => {});
    }, delayMs);
  }

  async startConnection(forceFreshQr = false) {
    // Se estava em modo demonstração, limpa todos os dados de teste antes de conectar o WhatsApp real
    if (this.connectionStatus === 'demo_mode') {
      clearDemoData();
      this.sessionStats = { storedMessages: 0, discardedPrivateMessages: 0 };
      this.connectedUser = null;
    }

    if (!forceFreshQr && this.connectionStatus === 'connected' && this.sock) {
      return this.getStatus();
    }

    this.manualDisconnect = false;
    this.lastError = null;
    this.qrDataUrl = null;
    this.pairingMessage = 'Iniciando conexão segura com o WhatsApp...';
    this.connectionStatus = 'connecting';

    this._disposeSocket();

    if (forceFreshQr) {
      this.clearAuthFolder();
    } else {
      try {
        const credsFile = path.join(AUTH_DIR, 'creds.json');
        if (fs.existsSync(credsFile)) {
          const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
          if (!creds?.me?.id) {
            this.clearAuthFolder();
          }
        }
      } catch {
        this.clearAuthFolder();
      }
    }

    await this._openSocket();
    return this.getStatus();
  }

  async _openSocket() {
    this._disposeSocket();

    try {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      this.authState = state;

      let version = [2, 3000, 1052208262];
      try {
        const latest = await Promise.race([
          fetchLatestWaWebVersion(),
          sleep(3500).then(() => null)
        ]);
        if (latest?.version) {
          version = latest.version;
        } else {
          const fallback = await Promise.race([
            fetchLatestBaileysVersion(),
            sleep(2500).then(() => null)
          ]);
          if (fallback?.version) version = fallback.version;
        }
      } catch {
        // mantém versão recente padrão
      }

      const browserTuple =
        process.platform === 'darwin'
          ? Browsers.macOS('Desktop')
          : process.platform === 'win32'
          ? Browsers.windows('Desktop')
          : Browsers.ubuntu('Desktop');

      const currentSock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: browserTuple,
        syncFullHistory: false, // Não pede arquivo completo de anos ao WhatsApp
        shouldSyncHistoryMessage: () => true, // Permite receber cursores iniciais, mapeamentos LID e pacotes ON_DEMAND
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 500
      });

      this.sock = currentSock;
      this.hasCompletedAppStateSync = false;
      let lastSeenAppStateKeyId = state.creds?.myAppStateKeyId || null;

      currentSock.ev.on('creds.update', (update) => {
        this.credsSaveChain = this.credsSaveChain.then(() => saveCreds()).catch(() => {});
        // Só sincroniza quando chega uma NOVA chave AppState (evita disparo falso a cada 10min no CB:ib,,edge_routing!)
        if (
          update?.myAppStateKeyId &&
          update.myAppStateKeyId !== lastSeenAppStateKeyId &&
          currentSock === this.sock
        ) {
          lastSeenAppStateKeyId = update.myAppStateKeyId;
          logInfo('whatsapp', 'Nova chave AppState recebida do celular; agendando sincronização de contatos');
          this.scheduleAppStateSync(800, { force: true });
        }
      });

      currentSock.ev.on('connection.update', async (update) => {
        if (currentSock !== this.sock) return;

        const { connection, lastDisconnect, qr, isNewLogin } = update;

        if (qr) {
          this.connectionStatus = 'qr_ready';
          this.pairingMessage = null;
          this.lastError = null;
          this.qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
          logInfo('whatsapp', 'QR Code gerado e pronto para leitura');
        }

        if (isNewLogin) {
          this.connectionStatus = 'connecting';
          this.qrDataUrl = null;
          this.pairingMessage = 'QR Code lido! Finalizando sincronização com o celular...';
          logInfo('whatsapp', 'QR Code lido pelo usuário (isNewLogin=true)');
        }

        if (connection === 'open') {
          this.reconnectAttempts = 0;
          this.connectionStatus = 'connected';
          this.qrDataUrl = null;
          this.pairingMessage = null;
          this.lastError = null;
          const cleanId = currentSock.user?.id ? jidNormalizedUser(currentSock.user.id) : '';
          const phoneLabel = cleanId ? `+${cleanId.split('@')[0]}` : 'WhatsApp Conectado';
          this.connectedUser = {
            id: cleanId,
            name: currentSock.user?.name || phoneLabel
          };
          logInfo('whatsapp', 'Conexão aberta com sucesso', { user: this.connectedUser.name });

          this.fetchInitialGroups({ force: false }).catch(() => {});

          const existingSavedContacts = getDirectoryChats().filter(
            (c) => !c.isGroup && c.nameSource === 'contact'
          ).length;

          // Se for pareamento recente ou poucos contatos salvos, sincroniza imediatamente
          if (existingSavedContacts < 30) {
            this.scheduleAppStateSync(1500, { force: true });
            setTimeout(() => {
              if (
                currentSock === this.sock &&
                this.connectionStatus === 'connected' &&
                !this.hasCompletedAppStateSync
              ) {
                this.syncContactsAndLabelsFromAppState({ silent: true, force: true }).catch(() => {});
              }
            }, 6500);
          } else if (
            this.lastFullAppStateSyncAt === 0 ||
            Date.now() - this.lastFullAppStateSyncAt >= 15 * 60 * 1000
          ) {
            logInfo('whatsapp', 'Agenda já populada no banco local; sincronizando etiquetas em segundo plano', {
              existingSavedContacts
            });
            this.scheduleAppStateSync(2200);
          } else {
            logInfo('whatsapp', 'Reconexão rápida concluída (agenda já sincronizada recentemente)', {
              existingSavedContacts
            });
          }
        }

        if (connection === 'close') {
          await this.credsSaveChain;
          if (currentSock !== this.sock) return;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          logWarn('whatsapp', 'Conexão encerrada', {
            statusCode,
            manualDisconnect: this.manualDisconnect,
            reason: lastDisconnect?.error?.message || ''
          });
          this.qrDataUrl = null;

          if (this.manualDisconnect) {
            this.connectionStatus = 'disconnected';
            this.pairingMessage = null;
            return;
          }

          // Código 515 (restartRequired) ocorre SEMPRE logo após escanear o QR Code!
          if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
            this.connectionStatus = 'connecting';
            this.pairingMessage = 'Sincronizando grupos e contatos...';
            this.reconnectTimer = setTimeout(() => {
              this._openSocket().catch(() => {});
            }, 250);
            return;
          }

          // Apenas 401 (loggedOut), 403 (forbidden) ou 411 (multideviceMismatch) indicam sessão realmente desvinculada.
          // Status 500 (Stream Errored ack / badSession no Baileys) é queda transitória de stream e DEVE reconectar sem apagar wa_auth!
          if (
            statusCode === DisconnectReason.loggedOut ||
            statusCode === DisconnectReason.forbidden ||
            statusCode === DisconnectReason.multideviceMismatch ||
            statusCode === 401 ||
            statusCode === 403 ||
            statusCode === 411
          ) {
            this.clearAuthFolder();
            this.connectedUser = null;
            this.connectionStatus = 'disconnected';
            this.pairingMessage = null;
            this.lastError = 'Sessão desconectada no celular. Gere um novo QR Code para conectar.';
            return;
          }

          if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
            this.connectionStatus = 'disconnected';
            this.pairingMessage = null;
            this.lastError = 'Conexão substituída por outra janela aberta. Clique para reconectar.';
            return;
          }

          if (statusCode === DisconnectReason.timedOut || statusCode === 408) {
            const credsFile = path.join(AUTH_DIR, 'creds.json');
            let isPaired = false;
            try {
              if (fs.existsSync(credsFile)) {
                isPaired = Boolean(JSON.parse(fs.readFileSync(credsFile, 'utf8'))?.me?.id);
              }
            } catch {
              isPaired = false;
            }

            if (!isPaired) {
              this.clearAuthFolder();
              this.connectionStatus = 'disconnected';
              this.pairingMessage = null;
              this.lastError = 'O tempo de leitura do QR Code expirou. Clique para gerar novamente.';
              return;
            }
          }

          this.reconnectAttempts += 1;
          const delayMs = Math.min(
            Math.round(1800 * Math.pow(1.7, Math.min(this.reconnectAttempts - 1, 5))),
            15000
          );
          this.connectionStatus = 'connecting';
          this.pairingMessage = 'Reconectando automaticamente ao WhatsApp...';
          logInfo('whatsapp', 'Agendando reconexão automática preservando sessão', {
            attempt: this.reconnectAttempts,
            delayMs,
            statusCode
          });
          this.reconnectTimer = setTimeout(() => {
            this._openSocket().catch(() => {});
          }, delayMs);
        }
      });

      // Quando o usuário edita um contato ou etiqueta no celular com o app aberto, o WhatsApp envia dirty=account_sync
      try {
        currentSock.ws.on('CB:ib,,dirty', (node) => {
          if (currentSock !== this.sock) return;
          const dirtyChild = Array.isArray(node?.content)
            ? node.content.find((c) => c?.tag === 'dirty')
            : null;
          if (dirtyChild?.attrs?.type === 'account_sync') {
            this.scheduleAppStateSync(2500, { force: true });
          }
        });
      } catch {
        // ignora
      }

      // Sincronização de nomes, vínculos LID<->Telefone, cursores opacos e mensagens sob demanda (ON_DEMAND)
      currentSock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
        const t0 = Date.now();
        runInTransaction(() => {
          for (const c of contacts) {
            this._registerContactMetadata(c);
          }

          for (const ch of chats) {
            const rawId = ch.id || '';
            if (rawId.endsWith('@lid') && ch.pnJid) {
              this._linkLidAndPhone(rawId, ch.pnJid, ch.name || '');
            } else if (rawId && !rawId.endsWith('@lid') && ch.lidJid) {
              this._linkLidAndPhone(ch.lidJid, rawId, ch.name || '');
            }

            const jid = this._normalizeIncomingJid(rawId);
            if (!jid) continue;

            const isGroup = jid.endsWith('@g.us');
            if (isGroup) {
              const groupSubject = ch.name || ch.subject;
              if (groupSubject) {
                upsertDirectoryChat(jid, groupSubject, true, { nameSource: 'contact' });
              }
            } else if (ch.name) {
              upsertDirectoryChat(jid, ch.name, false, {
                nameSource: 'contact',
                lidJid: ch.lidJid || (rawId.endsWith('@lid') ? rawId : null)
              });
            } else if (ch.displayName || ch.verifiedName) {
              upsertDirectoryChat(jid, ch.displayName || ch.verifiedName, false, {
                nameSource: 'push',
                lidJid: ch.lidJid || (rawId.endsWith('@lid') ? rawId : null)
              });
            }

            const tipMsg = ch.messages?.[0]?.message;
            if (tipMsg?.key?.id) {
              updateChatLatestAnchor(jid, {
                msgId: tipMsg.key.id,
                fromMe: Boolean(tipMsg.key.fromMe),
                timestampMs: toTimestampMs(tipMsg.messageTimestamp),
                rawJid: tipMsg.key.remoteJid || rawId
              });
            }
          }

          for (const msg of messages) {
            this.handleIncomingWhatsAppMessage(msg);
          }
        });
        logInfo('history-sync', 'Pacote messaging-history.set processado', {
          chats: chats.length,
          contacts: contacts.length,
          messages: messages.length,
          elapsedMs: Date.now() - t0
        });
      });

      currentSock.ev.on('contacts.upsert', (contacts) => {
        runInTransaction(() => {
          for (const c of contacts) {
            this._registerContactMetadata(c);
          }
        });
      });

      currentSock.ev.on('contacts.update', (updates) => {
        runInTransaction(() => {
          for (const c of updates) {
            this._registerContactMetadata(c);
          }
        });
      });

      currentSock.ev.on('labels.edit', (label) => {
        if (!label?.id) return;
        const labelId = String(label.id);
        if (label.deleted) {
          this.labelNamesById.delete(labelId);
        } else if (label.name) {
          this.labelNamesById.set(labelId, String(label.name).trim());
        }
        try {
          saveWhatsAppLabelsCatalog(this.labelNamesById);
        } catch {
          // ignora
        }
      });

      currentSock.ev.on('labels.association', ({ type, association }) => {
        if (!association?.chatId || !association?.labelId) return;
        if (association.messageId) return; // ignora etiqueta de mensagem individual
        const labelName = this.labelNamesById.get(String(association.labelId));
        if (!labelName) return;
        const jid = this._normalizeIncomingJid(association.chatId);
        updateSingleChatLabel(jid, labelName, type === 'add');
      });

      currentSock.ev.on('chats.upsert', (chats) => {
        for (const ch of chats) {
          if (!ch.id) continue;
          const jid = this._normalizeIncomingJid(ch.id);
          const isGroup = jid.endsWith('@g.us');
          const name = ch.name || ch.subject;
          if (name) {
            upsertDirectoryChat(jid, name, isGroup, {
              nameSource: 'contact',
              lidJid: ch.lidJid || (ch.id.endsWith('@lid') ? ch.id : null)
            });
          } else if (ch.displayName) {
            upsertDirectoryChat(jid, ch.displayName, false, { nameSource: 'push' });
          }
        }
      });

      currentSock.ev.on('groups.upsert', (groups) => {
        for (const g of groups) {
          if (g.id && g.subject) {
            upsertDirectoryChat(g.id, g.subject, true, { nameSource: 'contact' });
          }
        }
      });

      currentSock.ev.on('groups.update', (groups) => {
        for (const g of groups) {
          if (g.id && g.subject) {
            upsertDirectoryChat(g.id, g.subject, true, { nameSource: 'contact' });
          }
        }
      });

      // O PORTEIRO NA INGESTÃO DE MENSAGENS
      currentSock.ev.on('messages.upsert', ({ messages }) => {
        runInTransaction(() => {
          for (const msg of messages) {
            if (msg?.message?.protocolMessage?.appStateSyncKeyShare) {
              this.scheduleAppStateSync(900, { force: true });
            }
            const histNotif = getHistoryMsg(msg?.message);
            if (
              histNotif &&
              (histNotif.syncType === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP ||
                histNotif.syncType === proto.HistorySync.HistorySyncType.RECENT)
            ) {
              this._extractPhoneToLidMappingsFromHistory(histNotif).catch(() => {});
            }
            this.handleIncomingWhatsAppMessage(msg);
          }
        });
      });
    } catch (err) {
      logError('whatsapp', 'Erro em _openSocket', err);
      let isPaired = false;
      try {
        const credsFile = path.join(AUTH_DIR, 'creds.json');
        if (fs.existsSync(credsFile)) {
          isPaired = Boolean(JSON.parse(fs.readFileSync(credsFile, 'utf8'))?.me?.id);
        }
      } catch {
        isPaired = false;
      }
      if (!this.manualDisconnect && isPaired) {
        this.reconnectAttempts += 1;
        const delayMs = Math.min(
          Math.round(2500 * Math.pow(1.7, Math.min(this.reconnectAttempts - 1, 5))),
          20000
        );
        this.connectionStatus = 'connecting';
        this.pairingMessage = 'Aguardando rede para reconectar ao WhatsApp...';
        this.reconnectTimer = setTimeout(() => {
          this._openSocket().catch(() => {});
        }, delayMs);
      } else {
        this.connectionStatus = 'disconnected';
        this.pairingMessage = null;
        this.lastError = err?.message || 'Erro ao iniciar conexão WhatsApp';
      }
    }
  }

  async _extractPhoneToLidMappingsFromHistory(histNotif) {
    try {
      const syncData = await downloadHistory(histNotif, {});
      runInTransaction(() => {
        for (const mapping of syncData?.phoneNumberToLidMappings || []) {
          if (mapping?.lidJid && mapping?.pnJid) {
            this._linkLidAndPhone(mapping.lidJid, mapping.pnJid, '');
          }
        }
        for (const conv of syncData?.conversations || []) {
          if (conv?.id?.endsWith('@lid') && conv.pnJid) {
            this._linkLidAndPhone(conv.id, conv.pnJid, conv.name || '');
          } else if (conv?.id && !conv.id.endsWith('@lid') && conv.lidJid) {
            this._linkLidAndPhone(conv.lidJid, conv.id, conv.name || '');
          }
        }
      });
    } catch {
      // ignora falhas de rede pontuais
    }
  }

  _linkLidAndPhone(lidJid, pnJid, contactName = '') {
    const normLid = normalizeChatJid(lidJid);
    const normPn = normalizeChatJid(pnJid);
    if (!normLid || !normPn || !normLid.endsWith('@lid') || normPn.endsWith('@lid')) return;

    const prev = this.lidMap.get(normLid);
    const bestName = (contactName || prev?.name || '').trim();
    this.lidMap.set(normLid, { jid: normPn, name: bestName });
    mergeLidIntoPhoneChat(normLid, normPn, bestName);
  }

  _registerContactMetadata(c) {
    if (!c) return;
    const savedName = (c.name || '').trim();
    const pushOrVerified = (c.notify || c.verifiedName || '').trim();
    const chosenName = savedName || pushOrVerified;
    const nameSource = savedName ? 'contact' : 'push';

    const rawId = c.id || '';
    const lidCandidate =
      c.lid || c.lidJid || (rawId.endsWith('@lid') ? rawId : '');
    const pnCandidate =
      c.pnJid ||
      (c.jid && !c.jid.endsWith('@lid') ? c.jid : '') ||
      (rawId && !rawId.endsWith('@lid') && !rawId.endsWith('@g.us') ? rawId : '');

    if (lidCandidate && pnCandidate) {
      this._linkLidAndPhone(lidCandidate, pnCandidate, savedName);
    } else if (lidCandidate && chosenName) {
      const prev = this.lidMap.get(normalizeChatJid(lidCandidate));
      this.lidMap.set(normalizeChatJid(lidCandidate), {
        jid: prev?.jid || normalizeChatJid(lidCandidate),
        name: savedName || prev?.name || chosenName
      });
    }

    const targetJid = pnCandidate || lidCandidate || rawId;
    if (targetJid && chosenName) {
      const isGroup = targetJid.endsWith('@g.us');
      upsertDirectoryChat(targetJid, chosenName, isGroup, {
        nameSource: isGroup ? 'contact' : nameSource,
        lidJid: lidCandidate || null
      });
    }
  }

  /**
   * Sincroniza diretamente do WhatsApp AppState (w:sync:app:state):
   * 1) Todos os contatos salvos na agenda do celular (contactAction + lidContactAction)
   * 2) Todos os vínculos @lid <-> número @s.whatsapp.net (pnForLidChatAction)
   * 3) Todas as Etiquetas e Listas Personalizadas do WhatsApp (labelEditAction + labelAssociationAction, ex: [EMP])
   *
   * Contorna os dois bugs do Baileys 6.7.24 (condição de corrida do SyncState e ausência de suporte a lidContactAction).
   */
  async syncContactsAndLabelsFromAppState({ silent = true, force = false } = {}) {
    if (this.connectionStatus === 'demo_mode') {
      const msg = 'Agenda de exemplo sincronizada.';
      if (!silent) {
        this.historySyncStatus = { active: false, message: msg, updatedAt: Date.now() };
      }
      return { ok: true, contactsSynced: 4, labelsSynced: 0, message: msg };
    }

    if (this.connectionStatus !== 'connected' || !this.sock || !this.authState) {
      return {
        ok: false,
        message: 'Conecte o WhatsApp primeiro para atualizar seus contatos.'
      };
    }

    if (silent && this.lastFullAppStateSyncAt > 0) {
      const elapsed = Date.now() - this.lastFullAppStateSyncAt;
      const minGapMs = force ? 45_000 : 15 * 60_000;
      if (elapsed < minGapMs) {
        return {
          ok: true,
          throttled: true,
          message: 'Agenda já sincronizada recentemente.'
        };
      }
    }

    if (this.isSyncingAppState) {
      return { ok: true, busy: true, message: 'Sincronização da agenda já está em andamento...' };
    }

    this.isSyncingAppState = true;
    const activeSock = this.sock;
    const authState = this.authState;

    if (!silent) {
      this.historySyncStatus = {
        active: true,
        message: 'Sincronizando contatos salvos e etiquetas do seu WhatsApp...',
        updatedAt: Date.now()
      };
    }

    try {
      await this.credsSaveChain;

      // Se acabou de conectar e o celular ainda está enviando o pacote de chaves, aguarda brevemente
      if (!this._hasAnyAppStateSyncKey()) {
        for (let i = 0; i < 8; i++) {
          await sleep(500);
          if (this._hasAnyAppStateSyncKey()) break;
        }
      }

      if (!this._hasAnyAppStateSyncKey()) {
        const waitMsg =
          'Aguardando o celular enviar as chaves da agenda. Mantenha o WhatsApp aberto no aparelho por alguns segundos e clique novamente.';
        if (!silent) {
          this.historySyncStatus = { active: false, message: waitMsg, updatedAt: Date.now() };
        }
        return { ok: false, noKeysYet: true, message: waitMsg };
      }

      // Também garante grupos atualizados (respeitando cooldown para evitar rate-overlimit do WhatsApp)
      await this.fetchInitialGroups({ force: !silent });

      const keyCache = new Map();
      const getDerivedKey = async (keyIdBytes) => {
        const base64Key = Buffer.from(keyIdBytes).toString('base64');
        if (keyCache.has(base64Key)) return keyCache.get(base64Key);
        const fetched = await authState.keys.get('app-state-sync-key', [base64Key]);
        const keyObj = fetched?.[base64Key];
        if (!keyObj?.keyData) {
          keyCache.set(base64Key, null);
          return null;
        }
        const expanded = await hkdf(keyObj.keyData, 160, { info: 'WhatsApp Mutation Keys' });
        const derived = { valueEncryptionKey: expanded.slice(32, 64), base64Key };
        keyCache.set(base64Key, derived);
        return derived;
      };

      let mutationSeq = 0;
      const decryptRecord = async (record, operation) => {
        if (!record?.keyId?.id || !record?.value?.blob) return null;
        const keys = await getDerivedKey(record.keyId.id);
        if (!keys) return null;
        const blob = Buffer.isBuffer(record.value.blob)
          ? record.value.blob
          : Buffer.from(record.value.blob);
        if (blob.length <= 32) return null;
        const encContent = blob.subarray(0, blob.length - 32);
        const decrypted = aesDecrypt(encContent, keys.valueEncryptionKey);
        const syncAction = proto.SyncActionData.decode(decrypted);
        const indexStr = Buffer.from(syncAction.index).toString('utf8');
        const indexArr = JSON.parse(indexStr);
        const isRemove = operation === proto.SyncdMutation.SyncdOperation.REMOVE;
        const indexBlob = record.index?.blob
          ? Buffer.isBuffer(record.index.blob)
            ? record.index.blob
            : Buffer.from(record.index.blob)
          : null;
        const slotKey = indexBlob
          ? indexBlob.toString('base64')
          : `${keys.base64Key}:${indexStr}`;
        mutationSeq += 1;
        return {
          slotKey,
          indexKey: indexStr,
          index: indexArr,
          action: syncAction.value,
          timestamp: toNumber(syncAction.value?.timestamp),
          seq: mutationSeq,
          isRemove
        };
      };

      const collectionsPending = new Map();
      for (const colName of ALL_WA_PATCH_NAMES) {
        collectionsPending.set(colName, { version: 0, needSnapshot: true, pages: 0 });
      }

      // No protocolo LTHash do WhatsApp, cada registro ativo é indexado por indexMac (HMAC(index, keyId)).
      // Quando o WhatsApp rotaciona chaves, o mesmo patch traz [SET(keyNova), REMOVE(keyAntiga)].
      // Indexar pelo slotKey (indexMac) evita que o REMOVE da chave antiga apague o SET da chave nova!
      const activeBySlot = new Map();
      const collectionDecryptedCounts = new Map();
      const succeededCollections = new Set();

      let rounds = 0;
      while (collectionsPending.size > 0 && rounds < 20 && this.sock === activeSock) {
        rounds += 1;
        const nodes = [];
        for (const [colName, meta] of collectionsPending.entries()) {
          nodes.push({
            tag: 'collection',
            attrs: {
              name: colName,
              version: String(meta.version),
              return_snapshot: meta.needSnapshot ? 'true' : 'false'
            }
          });
        }

        const iqResult = await activeSock.query(
          {
            tag: 'iq',
            attrs: {
              to: S_WHATSAPP_NET,
              xmlns: 'w:sync:app:state',
              type: 'set'
            },
            content: [
              {
                tag: 'sync',
                attrs: {},
                content: nodes
              }
            ]
          },
          25000
        );

        const extracted = await extractSyncdPatches(iqResult, {});

        for (const [colName, meta] of Array.from(collectionsPending.entries())) {
          const colData = extracted?.[colName];
          if (!colData) {
            collectionsPending.delete(colName);
            continue;
          }

          let nextVersion = meta.version;

          if (colData.snapshot) {
            const snapVer = toNumber(colData.snapshot.version?.version);
            if (snapVer > nextVersion) nextVersion = snapVer;
            const records = colData.snapshot.records || [];
            for (let idx = 0; idx < records.length; idx++) {
              if (idx > 0 && idx % 120 === 0) {
                await sleep(0); // libera event loop para manter servidor 100% responsivo
              }
              try {
                const dec = await decryptRecord(records[idx], proto.SyncdMutation.SyncdOperation.SET);
                if (dec) {
                  activeBySlot.set(`${colName}:${dec.slotKey}`, { ...dec, colName });
                  collectionDecryptedCounts.set(colName, (collectionDecryptedCounts.get(colName) || 0) + 1);
                }
              } catch {
                // ignora registro isolado com chave antiga ausente
              }
            }
          }

          for (const patch of colData.patches || []) {
            if (patch.externalMutations) {
              try {
                const ext = await downloadExternalPatch(patch.externalMutations, {});
                patch.mutations = [...(patch.mutations || []), ...(ext?.mutations || [])];
              } catch {
                // ignora falha de blob externo isolado
              }
            }
            const patchVer = toNumber(patch.version?.version);
            if (patchVer > nextVersion) nextVersion = patchVer;

            const muts = patch.mutations || [];
            for (let idx = 0; idx < muts.length; idx++) {
              if (idx > 0 && idx % 120 === 0) {
                await sleep(0);
              }
              const mut = muts[idx];
              const op =
                'operation' in mut ? mut.operation : proto.SyncdMutation.SyncdOperation.SET;
              const rec = mut.record || mut;
              try {
                const dec = await decryptRecord(rec, op);
                if (dec) {
                  collectionDecryptedCounts.set(colName, (collectionDecryptedCounts.get(colName) || 0) + 1);
                  if (dec.isRemove) {
                    activeBySlot.delete(`${colName}:${dec.slotKey}`);
                  } else {
                    activeBySlot.set(`${colName}:${dec.slotKey}`, { ...dec, colName });
                  }
                }
              } catch {
                // ignora mutação isolada com chave antiga ausente
              }
            }
          }

          succeededCollections.add(colName);

          if (colData.hasMorePatches && nextVersion > meta.version && meta.pages < 20) {
            collectionsPending.set(colName, {
              version: nextVersion,
              needSnapshot: false,
              pages: meta.pages + 1
            });
          } else {
            collectionsPending.delete(colName);
          }
        }
      }

      // Consolida registros ativos por indexKey escolhendo sempre o timestamp/seq mais recente
      const allMutations = new Map();
      for (const item of activeBySlot.values()) {
        const logicalKey = `${item.colName}:${item.indexKey}`;
        const prev = allMutations.get(logicalKey);
        if (
          !prev ||
          item.timestamp > prev.timestamp ||
          (item.timestamp === prev.timestamp && item.seq > prev.seq)
        ) {
          allMutations.set(logicalKey, item);
        }
      }

      const dbStart = Date.now();
      let contactsSynced = 0;
      const labelDefs = new Map();
      const chatLabelsMap = new Map();
      const regularHasRecords =
        succeededCollections.has('regular') && (collectionDecryptedCounts.get('regular') || 0) > 0;

      // Grava todos os 1.000+ contatos e etiquetas em UMA ÚNICA transação SQLite (~3ms no total!)
      runInTransaction(() => {
        // PASSO 1A: Vínculos @lid <-> @s.whatsapp.net explícitos (pnForLidChatAction)
        for (const m of allMutations.values()) {
          if (!m.isRemove && m.action?.pnForLidChatAction?.pnJid && m.index?.[1]) {
            this._linkLidAndPhone(m.index[1], m.action.pnForLidChatAction.pnJid, '');
          }
        }

        // PASSO 1B: Contatos salvos na agenda (contactAction + lidContactAction)
        for (const m of allMutations.values()) {
          if (m.isRemove) continue;

          if (m.action?.contactAction) {
            const ca = m.action.contactAction;
            const savedName = (ca.fullName || ca.firstName || ca.username || '').trim();
            const indexId = String(m.index?.[1] || '');
            const lidJid = ca.lidJid || (indexId.endsWith('@lid') ? indexId : '');
            const pnJid =
              ca.pnJid || (!indexId.endsWith('@lid') && indexId.includes('@') ? indexId : '');

            if (lidJid && pnJid) {
              this._linkLidAndPhone(lidJid, pnJid, savedName);
            }

            if (pnJid && savedName) {
              upsertDirectoryChat(pnJid, savedName, false, {
                nameSource: 'contact',
                lidJid: lidJid || null
              });
              contactsSynced += 1;
            } else if (lidJid && savedName) {
              upsertDirectoryChat(lidJid, savedName, false, { nameSource: 'contact' });
              contactsSynced += 1;
            }
          } else if (m.action?.lidContactAction) {
            const lca = m.action.lidContactAction;
            const savedName = (lca.fullName || lca.firstName || lca.username || '').trim();
            const lidId = String(m.index?.[1] || '');
            if (lidId && savedName) {
              const normLid = normalizeChatJid(lidId);
              if (this.lidMap.has(normLid)) {
                const prev = this.lidMap.get(normLid);
                this.lidMap.set(normLid, { ...prev, name: savedName });
              }
              upsertDirectoryChat(normLid, savedName, false, { nameSource: 'contact' });
              contactsSynced += 1;
            }
          }
        }

        // PASSO 2: Etiquetas e Listas Personalizadas do WhatsApp (ex: [EMP], Clientes VIP)
        if (regularHasRecords) {
          this.labelNamesById.clear();
        }
        for (const m of allMutations.values()) {
          if (m.action?.labelEditAction) {
            const labelId = String(m.index?.[1] ?? '');
            const lea = m.action.labelEditAction;
            if (m.isRemove || lea.deleted) {
              labelDefs.delete(labelId);
              this.labelNamesById.delete(labelId);
            } else if (labelId && lea.name && String(lea.name).trim()) {
              const cleanLabel = String(lea.name).trim();
              labelDefs.set(labelId, cleanLabel);
              this.labelNamesById.set(labelId, cleanLabel);
            }
          }
        }

        for (const m of allMutations.values()) {
          if (m.action?.labelAssociationAction) {
            const assocType = m.index?.[0];
            const labelId = String(m.index?.[1] ?? '');
            const rawChatId = String(m.index?.[2] ?? '');
            const isChatAssoc =
              assocType === 'label_jid' || (m.index?.length === 3 && rawChatId.includes('@'));
            if (!isChatAssoc || !labelId || !rawChatId) continue;

            const labelName = labelDefs.get(labelId) || this.labelNamesById.get(labelId);
            if (!labelName) continue;

            const canonical = resolveCanonicalJid(this._normalizeIncomingJid(rawChatId));
            if (!canonical) continue;

            const isLabeled = !m.isRemove && Boolean(m.action.labelAssociationAction.labeled);
            if (isLabeled) {
              if (!chatLabelsMap.has(canonical)) chatLabelsMap.set(canonical, new Set());
              chatLabelsMap.get(canonical).add(labelName);
            } else {
              chatLabelsMap.get(canonical)?.delete(labelName);
            }
          }
        }

        if (regularHasRecords) {
          replaceAllChatLabelsFromSync(chatLabelsMap);
          saveWhatsAppLabelsCatalog(this.labelNamesById);
        } else if (chatLabelsMap.size > 0) {
          for (const [jid, set] of chatLabelsMap.entries()) {
            setChatLabels(jid, Array.from(set));
          }
          if (this.labelNamesById.size > 0) {
            saveWhatsAppLabelsCatalog(this.labelNamesById);
          }
        }
      });

      this.hasCompletedAppStateSync = true;
      this.lastFullAppStateSyncAt = Date.now();
      const allChatsAfter = getDirectoryChats();
      const authorizedTotal = allChatsAfter.filter((c) => c.isAuthorized).length;
      const labeledChatsCount = allChatsAfter.filter((c) => Array.isArray(c.labels) && c.labels.length > 0).length;
      logInfo('appstate-sync', 'Sincronização de agenda e etiquetas concluída', {
        mutationsDecoded: allMutations.size,
        contactsSynced,
        labelsSynced: labelDefs.size,
        labeledChatsCount,
        authorizedTotal,
        sqliteTxMs: Date.now() - dbStart
      });

      const doneMsg =
        contactsSynced > 0 || labelDefs.size > 0
          ? `Agenda e etiquetas sincronizadas: ${contactsSynced} contatos salvos e ${labeledChatsCount} conversas com lista/etiqueta (${authorizedTotal} liberadas pelos seus filtros).`
          : 'Agenda verificada com sucesso.';

      if (!silent || contactsSynced > 0 || labeledChatsCount > 0) {
        this.historySyncStatus = {
          active: false,
          message: doneMsg,
          updatedAt: Date.now()
        };
      }

      return {
        ok: true,
        contactsSynced,
        labelsSynced: labelDefs.size,
        labeledChatsCount,
        authorizedTotal,
        message: doneMsg
      };
    } catch (err) {
      logError('appstate-sync', 'Falha na sincronização AppState', err);
      const errMsg = `Não foi possível sincronizar a agenda agora: ${err?.message || 'erro de rede'}`;
      if (!silent) {
        this.historySyncStatus = {
          active: false,
          message: errMsg,
          updatedAt: Date.now()
        };
      }
      return { ok: false, message: errMsg };
    } finally {
      this.isSyncingAppState = false;
    }
  }

  async fetchInitialGroups({ force = false } = {}) {
    if (!this.sock) return;
    const minGapMs = force ? 60_000 : 15 * 60_000;
    if (this.lastGroupsFetchAt > 0 && Date.now() - this.lastGroupsFetchAt < minGapMs) {
      return;
    }
    try {
      this.lastGroupsFetchAt = Date.now();
      const groups = await this.sock.groupFetchAllParticipating();
      const entries = Object.entries(groups || {});
      runInTransaction(() => {
        for (const [jid, meta] of entries) {
          if (meta?.subject) {
            upsertDirectoryChat(jid, meta.subject, true, { nameSource: 'contact' });
          }
        }
      });
      logInfo('groups', 'Grupos participantes atualizados', { count: entries.length });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('rate-overlimit')) {
        this.lastGroupsFetchAt = Date.now();
      } else {
        this.lastGroupsFetchAt = 0;
      }
      logWarn('groups', 'Falha ao buscar grupos iniciais', msg);
    }
  }

  _normalizeIncomingJid(rawJid) {
    if (!rawJid) return '';
    const norm = normalizeChatJid(rawJid);
    if (norm.endsWith('@lid')) {
      if (this.lidMap.has(norm)) {
        const mapped = this.lidMap.get(norm);
        if (mapped?.jid && !mapped.jid.endsWith('@lid')) {
          return normalizeChatJid(mapped.jid);
        }
      }
      return resolveCanonicalJid(norm);
    }
    return norm;
  }

  handleIncomingWhatsAppMessage(msg) {
    if (!msg?.key?.remoteJid) return;
    const rawJid = msg.key.remoteJid;
    if (rawJid === 'status@broadcast' || rawJid.endsWith('@broadcast') || rawJid.endsWith('@newsletter')) {
      return;
    }

    const normRaw = normalizeChatJid(rawJid);
    const jid = this._normalizeIncomingJid(rawJid);
    const mappedInfo = normRaw.endsWith('@lid') ? this.lidMap.get(normRaw) : null;
    const mappedName = mappedInfo?.name || '';

    const timestamp = toTimestampMs(msg.messageTimestamp);
    const fromMe = Boolean(msg.key.fromMe);

    // Salva apenas o ponteiro opaco (sem conteúdo privado!) para permitir puxar histórico depois de filtrar
    if (msg.key.id) {
      updateChatLatestAnchor(jid, {
        msgId: msg.key.id,
        fromMe,
        timestampMs: timestamp,
        rawJid
      });
    }

    if (!msg.message) return;
    const content = this.extractMessageText(msg.message);
    if (!content) return;

    const pushName = msg.pushName || (fromMe ? 'Eu' : '');
    // O(1) lookup direto no SQLite por chave primária (evita varrer 1.300+ conversas a cada mensagem recebida!)
    const existingChat = getChatBasicInfo(jid);
    const chatName = existingChat?.name || mappedName || pushName || jid.split('@')[0];
    const nameSource = existingChat?.nameSource === 'contact' ? 'contact' : 'push';

    const result = ingestFilteredMessage({
      id: msg.key.id,
      jid,
      chatName,
      senderName: fromMe ? 'Eu' : pushName || mappedName || chatName,
      fromMe,
      content,
      timestamp,
      nameSource
    });

    if (result.stored) {
      this.sessionStats.storedMessages += 1;
    } else {
      this.sessionStats.discardedPrivateMessages += 1;
    }
  }

  /**
   * Puxa histórico anterior sob demanda APENAS de uma conversa já autorizada pelo filtro
   */
  async fetchHistoryForChat(jid, count = 50) {
    const auth = isChatAuthorized(jid);
    if (!auth.allowed) {
      throw new Error('Esta conversa não está liberada nos filtros.');
    }

    const targetJid = auth.canonicalJid || jid;
    const safeCount = Math.min(Math.max(Number(count) || 50, 10), 100);

    // Suporte no Modo Demonstração para teste visual imediato
    if (this.connectionStatus === 'demo_mode') {
      const baseTs = Date.now() - Math.floor(Math.random() * 5 + 3) * 3600 * 1000;
      const samples = [
        `[Histórico anterior] Alinhamento inicial registrado em ${auth.name || targetJid}.`,
        `[Histórico anterior] Cronograma revisado e validado com a equipe.`,
        `[Histórico anterior] Valores e prazos confirmados na semana passada.`
      ];
      samples.forEach((txt, i) => {
        ingestFilteredMessage({
          id: `demo_hist_${Date.now()}_${i}`,
          jid: targetJid,
          chatName: auth.name || targetJid,
          senderName: 'Histórico',
          fromMe: false,
          content: txt,
          timestamp: baseTs - i * 1800 * 1000,
          nameSource: 'contact'
        });
      });
      this.sessionStats.storedMessages += samples.length;
      return { requested: true, hasAnchor: true, addedImmediate: samples.length };
    }

    if (this.connectionStatus !== 'connected' || !this.sock) {
      throw new Error('Conecte seu WhatsApp antes de puxar o histórico.');
    }

    const cursor = getHistoryCursorForChat(targetJid);
    if (cursor) {
      await this.sock.fetchMessageHistory(
        safeCount,
        {
          remoteJid: cursor.rawJid || targetJid,
          fromMe: cursor.fromMe,
          id: cursor.msgId
        },
        cursor.timestampMs
      );
      addAuditLog({
        actor: 'Usuário / App',
        action: 'puxar_historico',
        target: auth.name || targetJid,
        details: `Solicitou até ${safeCount} mensagens anteriores ao celular`
      });
      return { requested: true, hasAnchor: true };
    }

    try {
      await this.sock.fetchMessageHistory(
        safeCount,
        { remoteJid: targetJid, fromMe: false, id: '' },
        Date.now()
      );
    } catch {
      // ignora erro de cursor vazio
    }
    return { requested: true, hasAnchor: false };
  }

  /**
   * Puxa o histórico antigo de TODAS as conversas atualmente liberadas pelos filtros (Grupos marcados + Tags)
   */
  async fetchHistoryForAuthorizedChats(countPerChat = 50, singleJid = null) {
    const resolvedSingle = singleJid ? resolveCanonicalJid(singleJid) : null;
    const targets = resolvedSingle
      ? getDirectoryChats().filter((c) => c.jid === resolvedSingle && c.isAuthorized)
      : getDirectoryChats().filter((c) => c.isAuthorized);

    if (targets.length === 0) {
      return {
        ok: false,
        message: 'Ative pelo menos um grupo ou contato com tag antes de puxar o histórico.'
      };
    }

    const beforeTotal = getDirectoryChats()
      .filter((c) => c.isAuthorized)
      .reduce((acc, c) => acc + (c.storedMessagesCount || 0), 0);

    this.historySyncStatus = {
      active: true,
      message:
        targets.length === 1
          ? `Buscando mensagens anteriores de "${targets[0].name}" no seu celular...`
          : `Buscando histórico de ${targets.length} conversas liberadas no seu celular...`,
      updatedAt: Date.now()
    };

    let anchorsFound = 0;
    for (const chat of targets) {
      try {
        const res = await this.fetchHistoryForChat(chat.jid, countPerChat);
        if (res.hasAnchor) anchorsFound += 1;
        await sleep(300);
      } catch {
        // continua para as próximas conversas autorizadas
      }
    }

    let added = 0;
    if (this.connectionStatus === 'demo_mode') {
      const nowTotal = getDirectoryChats()
        .filter((c) => c.isAuthorized)
        .reduce((acc, c) => acc + (c.storedMessagesCount || 0), 0);
      added = Math.max(0, nowTotal - beforeTotal);
    } else {
      for (let i = 0; i < 11; i++) {
        await sleep(500);
        const nowTotal = getDirectoryChats()
          .filter((c) => c.isAuthorized)
          .reduce((acc, c) => acc + (c.storedMessagesCount || 0), 0);
        added = Math.max(0, nowTotal - beforeTotal);
        if (added > 0 && i >= 4) break;
      }
    }

    let finalMsg = '';
    if (added > 0) {
      finalMsg = `+${added} mensagens anteriores carregadas com sucesso.`;
    } else if (anchorsFound === 0) {
      finalMsg =
        'Essa conversa ainda não possui mensagens recentes sincronizadas neste computador; assim que chegar ou sair uma mensagem nela, o histórico completo poderá ser puxado.';
    } else {
      finalMsg =
        'Solicitação enviada ao celular. Mantenha o WhatsApp aberto no aparelho — as mensagens aparecerão em instantes.';
    }

    this.historySyncStatus = {
      active: false,
      message: finalMsg,
      updatedAt: Date.now()
    };

    return { ok: true, added, anchorsFound, message: finalMsg };
  }

  autoFetchIfEmpty(jid) {
    if (this.connectionStatus !== 'connected' && this.connectionStatus !== 'demo_mode') return;
    const canonical = resolveCanonicalJid(jid);
    const chat = getDirectoryChats().find((c) => c.jid === canonical);
    if (chat && chat.isAuthorized && chat.storedMessagesCount === 0 && chat.hasHistoryCursor) {
      this.fetchHistoryForAuthorizedChats(50, canonical).catch(() => {});
    }
  }

  extractMessageText(messageObj) {
    if (!messageObj) return '';
    if (messageObj.conversation) return messageObj.conversation;
    if (messageObj.extendedTextMessage?.text) return messageObj.extendedTextMessage.text;
    if (messageObj.imageMessage?.caption) return `[Imagem] ${messageObj.imageMessage.caption}`;
    if (messageObj.videoMessage?.caption) return `[Vídeo] ${messageObj.videoMessage.caption}`;
    if (messageObj.documentMessage?.caption) return `[Documento] ${messageObj.documentMessage.caption}`;
    if (messageObj.documentWithCaptionMessage?.message?.documentMessage?.caption) {
      return `[Documento] ${messageObj.documentWithCaptionMessage.message.documentMessage.caption}`;
    }
    if (messageObj.audioMessage) return '[Mensagem de Áudio]';
    return '';
  }

  async disconnect(logout = false) {
    const wasDemo = this.connectionStatus === 'demo_mode';
    this.manualDisconnect = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.appStateSyncTimer) {
      clearTimeout(this.appStateSyncTimer);
      this.appStateSyncTimer = null;
    }

    if (this.sock) {
      const old = this.sock;
      this.sock = null;
      try {
        old.ev.removeAllListeners();
        if (logout) {
          await old.logout();
        } else {
          old.end(undefined);
        }
      } catch {
        // ignora
      }
    }

    if (wasDemo) {
      clearDemoData();
      this.sessionStats = { storedMessages: 0, discardedPrivateMessages: 0 };
    }

    if (logout) {
      this.clearAuthFolder();
    } else {
      try {
        const credsFile = path.join(AUTH_DIR, 'creds.json');
        if (fs.existsSync(credsFile)) {
          const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
          if (!creds?.me?.id) {
            this.clearAuthFolder();
          }
        }
      } catch {
        this.clearAuthFolder();
      }
    }

    this.authState = null;
    this.connectionStatus = 'disconnected';
    this.qrDataUrl = null;
    this.pairingMessage = null;
    this.connectedUser = null;
    return this.getStatus();
  }

  clearAuthFolder() {
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    } catch {
      // ignora
    }
  }

  /**
   * 4 CAMADAS ANTI-BANIMENTO PARA ENVIO DE MENSAGENS PELA IA
   */
  queueMessageFromAI({ jid, content }) {
    const settings = getSettings();

    if (!settings.aiEnabled) {
      addAuditLog({
        action: 'enviar_mensagem',
        target: jid,
        details: 'Bloqueado: Chave Geral da IA está Pausada',
        blocked: true
      });
      throw new Error('A chave geral da IA está PAUSADA no programa Guardião.');
    }

    const cleanContent = (content || '').trim();
    if (!cleanContent) {
      throw new Error('Conteúdo da mensagem não pode ser vazio.');
    }

    // TRAVA 1: Proibição de Contato Frio (Só envia para Grupos ou Contatos Autorizados)
    const auth = isChatAuthorized(jid);
    if (!auth.allowed) {
      addAuditLog({
        action: 'enviar_mensagem (Bloqueio Anti-Ban)',
        target: jid,
        details: `Tentativa de envio para contato fora da lista permitida (${auth.reason})`,
        blocked: true
      });
      throw new Error(
        `Bloqueio de Segurança Anti-Spam: O chat "${jid}" não está autorizado. A IA só pode enviar mensagens para grupos marcados ou contatos com Tag de trabalho.`
      );
    }

    const targetJid = auth.canonicalJid || jid;

    // TRAVA 2: Limite Rígido por Hora
    const sentLastHour = getSentMessagesLastHour();
    if (sentLastHour >= Number(settings.maxMessagesPerHour || 15)) {
      addAuditLog({
        action: 'enviar_mensagem (Rate Limit)',
        target: auth.name || targetJid,
        details: `Limite de ${settings.maxMessagesPerHour} mensagens/hora atingido.`,
        blocked: true
      });
      throw new Error(
        `Limite Anti-Banimento atingido (${sentLastHour}/${settings.maxMessagesPerHour} mensagens na última hora). Aguarde antes de enviar novas mensagens.`
      );
    }

    // TRAVA 3: Bloqueio de Copy-Paste em Massa (Mensagens idênticas seguidas)
    if (settings.blockDuplicateMessages) {
      const recentOutbox = getRecentOutboxItems(5).filter(
        (i) => i.status !== 'rejected' && i.status !== 'failed'
      );
      const duplicateCount = recentOutbox.filter(
        (i) => i.content.trim().toLowerCase() === cleanContent.toLowerCase()
      ).length;

      if (duplicateCount >= 2) {
        addAuditLog({
          action: 'enviar_mensagem (Anti-Spam Texto Repetido)',
          target: auth.name || targetJid,
          details: 'Bloqueado: Tentativa de enviar o mesmo texto idêntico para múltiplos contatos.',
          blocked: true
        });
        throw new Error(
          'Bloqueio Anti-Spam: Não é permitido enviar o exato mesmo texto repetido em sequência. Personalize a mensagem.'
        );
      }
    }

    // TRAVA 4: Política de 2 Níveis (Grupos Internos vs Contatos 1-a-1)
    const isGroup = targetJid.endsWith('@g.us');
    const needsApproval = isGroup
      ? Boolean(settings.requireApprovalForGroups)
      : Boolean(settings.requireApprovalForContacts);

    const initialStatus = needsApproval ? 'pending_approval' : 'queued';
    const queueId = enqueueOutboxMessage({
      jid: targetJid,
      chatName: auth.name || targetJid,
      isGroup,
      content: cleanContent,
      status: initialStatus,
      reason: needsApproval
        ? 'Aguardando aprovação de 1 clique do funcionário na tela do programa'
        : 'Na fila com simulador humano ("Digitando...") e intervalo anti-spam'
    });

    addAuditLog({
      action: needsApproval ? 'enviar_mensagem (Aguardando Aprovação)' : 'enviar_mensagem (Enfileirada)',
      target: auth.name || targetJid,
      details: `"${cleanContent.slice(0, 80)}${cleanContent.length > 80 ? '...' : ''}"`,
      blocked: false
    });

    return {
      queueId,
      status: initialStatus,
      chatName: auth.name || targetJid,
      message: needsApproval
        ? `Mensagem para "${auth.name}" colocada na Fila de Aprovação. O funcionário só precisa clicar em [Aprovar e Enviar] na janela do programa.`
        : `Mensagem para "${auth.name}" entrou na fila segura e será enviada em instantes após simular "Digitando...".`
    };
  }

  approveOutboxMessage(id, editedContent = null) {
    const updated = updateOutboxItem(id, {
      status: 'queued',
      content: editedContent || undefined,
      reason: 'Aprovado pelo usuário — aguardando envio humanizado'
    });
    if (updated) {
      this.processOutboxQueue().catch(() => {});
    }
    return updated;
  }

  rejectOutboxMessage(id) {
    return updateOutboxItem(id, {
      status: 'rejected',
      reason: 'Cancelado manualmente pelo funcionário'
    });
  }

  /**
   * Lista as Etiquetas / Listas personalizadas disponíveis no WhatsApp (ex: Clientes VIP, [EMP])
   */
  getAvailableLabels() {
    const pseudoSystem = new Set(['UNREAD', 'GROUPS', 'FAVORITES']);
    const byNameLower = new Map();

    for (const [id, name] of this.labelNamesById.entries()) {
      const cleanName = String(name || '').trim();
      if (!cleanName || pseudoSystem.has(cleanName.toUpperCase())) continue;
      byNameLower.set(cleanName.toLowerCase(), {
        id: String(id),
        name: cleanName
      });
    }

    for (const item of getWhatsAppLabelsCatalog()) {
      const key = item.name.toLowerCase();
      if (!byNameLower.has(key)) {
        byNameLower.set(key, { id: String(item.id), name: item.name });
      }
    }

    // Fallback: se o app acabou de atualizar antes de sincronizar o catálogo de IDs, lê os nomes já ativos nas conversas
    if (byNameLower.size === 0) {
      for (const ch of getDirectoryChats()) {
        for (const lbl of ch.labels || []) {
          const clean = String(lbl || '').trim();
          if (clean && !pseudoSystem.has(clean.toUpperCase()) && !byNameLower.has(clean.toLowerCase())) {
            byNameLower.set(clean.toLowerCase(), { id: null, name: clean });
          }
        }
      }
    }

    return Array.from(byNameLower.values());
  }

  _listAvailableAppStateKeyIds() {
    const found = new Set();
    try {
      if (fs.existsSync(AUTH_DIR)) {
        for (const file of fs.readdirSync(AUTH_DIR)) {
          if (file.startsWith('app-state-sync-key-') && file.endsWith('.json')) {
            const safeId = file.slice('app-state-sync-key-'.length, -5);
            // Reverte o fixFileName do useMultiFileAuthState ('/' -> '__')
            const realBase64Id = safeId.replace(/__/g, '/');
            if (realBase64Id) found.add(realBase64Id);
          }
        }
      }
    } catch {
      // ignora
    }
    if (this.authState?.creds?.myAppStateKeyId) {
      found.add(this.authState.creds.myAppStateKeyId);
    }

    return Array.from(found).sort((a, b) => {
      try {
        return Buffer.compare(Buffer.from(a, 'base64'), Buffer.from(b, 'base64'));
      } catch {
        return a.localeCompare(b);
      }
    });
  }

  _hasConflictInAppStateAck(iqNode) {
    if (!iqNode || !Array.isArray(iqNode.content)) return false;
    const syncNode = iqNode.content.find((c) => c?.tag === 'sync');
    if (!syncNode || !Array.isArray(syncNode.content)) return false;
    for (const colNode of syncNode.content) {
      if (colNode?.tag !== 'collection') continue;
      if (colNode.attrs?.type === 'error') return true;
      if (Array.isArray(colNode.content) && colNode.content.some((x) => x?.tag === 'error')) {
        return true;
      }
    }
    return false;
  }

  async _syncCollectionLTHashState(collectionName, { forceFromScratch = false } = {}) {
    const activeSock = this.sock;
    const authState = this.authState;
    if (!activeSock || !authState) {
      throw new Error('WhatsApp não está conectado.');
    }

    const getAppStateSyncKey = async (keyId) => {
      const fetched = await authState.keys.get('app-state-sync-key', [keyId]);
      return fetched?.[keyId];
    };

    if (forceFromScratch) {
      await authState.keys.set({ 'app-state-sync-version': { [collectionName]: null } });
    }

    const currentRes = await authState.keys.get('app-state-sync-version', [collectionName]);
    let state =
      !forceFromScratch && currentRes?.[collectionName]
        ? currentRes[collectionName]
        : newLTHashState();

    let hasMore = true;
    let pages = 0;
    while (hasMore && pages < 15 && this.sock === activeSock) {
      pages += 1;
      const iqResult = await activeSock.query(
        {
          tag: 'iq',
          attrs: {
            to: S_WHATSAPP_NET,
            xmlns: 'w:sync:app:state',
            type: 'set'
          },
          content: [
            {
              tag: 'sync',
              attrs: {},
              content: [
                {
                  tag: 'collection',
                  attrs: {
                    name: collectionName,
                    version: String(state.version || 0),
                    return_snapshot: state.version ? 'false' : 'true'
                  }
                }
              ]
            }
          ]
        },
        25000
      );

      const decoded = await extractSyncdPatches(iqResult, {});
      const colData = decoded?.[collectionName];
      if (!colData) {
        break;
      }

      try {
        // Reconstrução tolerante do LTHash (mesmo comportamento do WhatsApp oficial/whatsmeow):
        // o histórico da agenda (critical_unblock_low) costuma conter REMOVE apontando para índices que
        // nunca existiram (ex.: contato apagado/acesso à agenda revogado). O Baileys aborta com
        // "tried remove, but no previous op"; aqui esses REMOVE órfãos são ignorados com segurança.
        if (colData.snapshot) {
          state = await this._applyLTHashSnapshotLenient(collectionName, colData.snapshot, getAppStateSyncKey);
          await authState.keys.set({ 'app-state-sync-version': { [collectionName]: state } });
        }

        if (colData.patches && colData.patches.length > 0) {
          state = await this._applyLTHashPatchesLenient(
            collectionName,
            colData.patches,
            state,
            getAppStateSyncKey
          );
          await authState.keys.set({ 'app-state-sync-version': { [collectionName]: state } });
        }

        hasMore = Boolean(colData.hasMorePatches);
      } catch (err) {
        if (!forceFromScratch && state.version > 0) {
          logWarn('appstate-write', `Ressincronizando LTHash de ${collectionName} do zero após divergência`, {
            err: err?.message
          });
          return this._syncCollectionLTHashState(collectionName, { forceFromScratch: true });
        }
        throw err;
      }
    }

    return state;
  }

  async _deriveMutationKeys(getAppStateSyncKey, keyIdBytesOrB64) {
    const b64 =
      typeof keyIdBytesOrB64 === 'string'
        ? keyIdBytesOrB64
        : Buffer.from(keyIdBytesOrB64).toString('base64');
    const keyObj = await getAppStateSyncKey(b64);
    if (!keyObj?.keyData) return null;
    const expanded = Buffer.from(await hkdf(keyObj.keyData, 160, { info: 'WhatsApp Mutation Keys' }));
    return {
      indexKey: expanded.subarray(0, 32),
      valueEncryptionKey: expanded.subarray(32, 64),
      valueMacKey: expanded.subarray(64, 96),
      snapshotMacKey: expanded.subarray(96, 128),
      patchMacKey: expanded.subarray(128, 160)
    };
  }

  _computeSnapshotMac(lthash, version, name, snapshotMacKey) {
    const ver = Buffer.alloc(8);
    ver.writeUInt32BE(version >>> 0, 4);
    return hmacSign(Buffer.concat([Buffer.from(lthash), ver, Buffer.from(name, 'utf-8')]), snapshotMacKey, 'sha256');
  }

  async _mixLTHashLenient(state, mutations) {
    const indexValueMap = { ...(state.indexValueMap || {}) };
    const addBuffs = [];
    const subBuffs = [];
    let orphanRemoves = 0;
    for (const mut of mutations || []) {
      const operation = 'operation' in mut && mut.operation !== undefined && mut.operation !== null
        ? mut.operation
        : proto.SyncdMutation.SyncdOperation.SET;
      const record = mut.record || mut;
      if (!record?.index?.blob || !record?.value?.blob) continue;
      const indexMacB64 = Buffer.from(record.index.blob).toString('base64');
      const valueBlob = Buffer.from(record.value.blob);
      if (valueBlob.length < 32) continue;
      const valueMac = valueBlob.subarray(valueBlob.length - 32);
      const prevOp = indexValueMap[indexMacB64];

      if (operation === proto.SyncdMutation.SyncdOperation.REMOVE) {
        if (!prevOp) {
          orphanRemoves += 1;
          continue;
        }
        delete indexValueMap[indexMacB64];
      } else {
        addBuffs.push(new Uint8Array(valueMac).buffer);
        indexValueMap[indexMacB64] = { valueMac: Buffer.from(valueMac) };
      }
      if (prevOp?.valueMac) {
        subBuffs.push(new Uint8Array(Buffer.from(prevOp.valueMac)).buffer);
      }
    }
    const hashAb = new Uint8Array(Buffer.from(state.hash || Buffer.alloc(128))).buffer;
    const result = await LT_HASH_ANTI_TAMPERING.subtractThenAdd(hashAb, addBuffs, subBuffs);
    return { hash: Buffer.from(result), indexValueMap, orphanRemoves };
  }

  async _applyLTHashSnapshotLenient(collectionName, snapshot, getAppStateSyncKey) {
    const base = newLTHashState();
    const version = toNumber(snapshot.version?.version);
    const mixed = await this._mixLTHashLenient(base, snapshot.records || []);
    const next = { version, hash: mixed.hash, indexValueMap: mixed.indexValueMap };
    try {
      const keys = snapshot.keyId?.id ? await this._deriveMutationKeys(getAppStateSyncKey, snapshot.keyId.id) : null;
      if (keys && snapshot.mac) {
        const mac = this._computeSnapshotMac(next.hash, version, collectionName, keys.snapshotMacKey);
        if (Buffer.compare(mac, Buffer.from(snapshot.mac)) !== 0) {
          logWarn('appstate-write', `LTHash do snapshot de ${collectionName} divergente (seguindo em modo tolerante)`, { version });
        }
      }
    } catch {
      // validação informativa apenas
    }
    return next;
  }

  async _applyLTHashPatchesLenient(collectionName, patches, initialState, getAppStateSyncKey) {
    let state = {
      ...initialState,
      indexValueMap: { ...(initialState.indexValueMap || {}) }
    };
    let totalOrphans = 0;
    let macMismatches = 0;
    for (const syncd of patches) {
      const patchVersion = toNumber(syncd.version?.version);
      if (patchVersion && patchVersion <= (state.version || 0)) {
        continue; // patch já aplicado anteriormente
      }
      let mutations = [...(syncd.mutations || [])];
      if (syncd.externalMutations) {
        try {
          const ext = await downloadExternalPatch(syncd.externalMutations, {});
          mutations = mutations.concat(ext?.mutations || []);
        } catch (err) {
          throw new Error(`Falha ao baixar patch externo de ${collectionName}: ${err?.message || 'rede'}`);
        }
      }
      const mixed = await this._mixLTHashLenient(state, mutations);
      totalOrphans += mixed.orphanRemoves;
      state = { version: patchVersion, hash: mixed.hash, indexValueMap: mixed.indexValueMap };

      try {
        const keys = syncd.keyId?.id ? await this._deriveMutationKeys(getAppStateSyncKey, syncd.keyId.id) : null;
        if (keys && syncd.snapshotMac) {
          const mac = this._computeSnapshotMac(state.hash, state.version, collectionName, keys.snapshotMacKey);
          if (Buffer.compare(mac, Buffer.from(syncd.snapshotMac)) !== 0) macMismatches += 1;
        }
      } catch {
        // validação informativa apenas
      }
    }
    if (totalOrphans > 0 || macMismatches > 0) {
      logInfo('appstate-write', `LTHash de ${collectionName} reconstruído em modo tolerante`, {
        orphanRemovesIgnored: totalOrphans,
        macMismatches,
        version: state.version
      });
    }
    return state;
  }

  async _findExistingKeyForIndex(indexArr, state, getAppStateSyncKey, keyIds) {
    if (!state?.indexValueMap || !keyIds?.length) return null;
    const indexBuffer = Buffer.from(JSON.stringify(indexArr));
    for (let i = keyIds.length - 1; i >= 0; i--) {
      const keyId = keyIds[i];
      try {
        const keyObj = await getAppStateSyncKey(keyId);
        if (!keyObj?.keyData) continue;
        const expanded = await hkdf(keyObj.keyData, 160, { info: 'WhatsApp Mutation Keys' });
        const indexKey = expanded.slice(0, 32);
        const macB64 = hmacSign(indexBuffer, indexKey).toString('base64');
        if (state.indexValueMap[macB64]) {
          return { keyId, macB64 };
        }
      } catch {
        // continua
      }
    }
    return null;
  }

  /**
   * Grava uma mutação AppState (ContactAction / LabelAssociationAction) de forma 100% compatível
   * com contas que possuem múltiplas chaves app-state-sync-key rotacionadas (evita corrupção de LTHash).
   */
  async applySafeAppStatePatch(patchCreate) {
    const executeSerialized = async () => {
      const activeSock = this.sock;
      const authState = this.authState;
      if (this.connectionStatus !== 'connected' || !activeSock || !authState) {
        throw new Error('Conecte o WhatsApp primeiro para gravar contatos na agenda do celular.');
      }

      const runWithSocketMutex = async (fn) => {
        if (activeSock.processingMutex?.mutex) {
          return activeSock.processingMutex.mutex(fn);
        }
        return fn();
      };

      return runWithSocketMutex(async () => {
        const collectionName = patchCreate.type;
        const getAppStateSyncKey = async (keyId) => {
          const fetched = await authState.keys.get('app-state-sync-key', [keyId]);
          return fetched?.[keyId];
        };

        for (let attempt = 0; attempt < 2; attempt++) {
          const state = await this._syncCollectionLTHashState(collectionName, {
            forceFromScratch: attempt > 0
          });
          const keyIds = this._listAvailableAppStateKeyIds();
          if (keyIds.length === 0) {
            throw new Error(
              'As chaves de sincronização da agenda ainda não foram enviadas pelo celular. Aguarde alguns segundos com o WhatsApp aberto e tente novamente.'
            );
          }

          const existingSlot = await this._findExistingKeyForIndex(
            patchCreate.index,
            state,
            getAppStateSyncKey,
            keyIds
          );
          const signingKeyId =
            existingSlot?.keyId ||
            authState.creds?.myAppStateKeyId ||
            keyIds[keyIds.length - 1];

          const { patch, state: nextState } = await encodeSyncdPatch(
            patchCreate,
            signingKeyId,
            state,
            getAppStateSyncKey
          );

          const iqNode = {
            tag: 'iq',
            attrs: {
              to: S_WHATSAPP_NET,
              type: 'set',
              xmlns: 'w:sync:app:state'
            },
            content: [
              {
                tag: 'sync',
                attrs: {},
                content: [
                  {
                    tag: 'collection',
                    attrs: {
                      name: collectionName,
                      version: String(nextState.version - 1),
                      return_snapshot: 'false'
                    },
                    content: [
                      {
                        tag: 'patch',
                        attrs: {},
                        content: proto.SyncdPatch.encode(patch).finish()
                      }
                    ]
                  }
                ]
              }
            ]
          };

          try {
            const ack = await activeSock.query(iqNode, 20000);
            if (this._hasConflictInAppStateAck(ack)) {
              if (attempt === 0) {
                logWarn('appstate-write', `Conflito 409 em ${collectionName}; ressincronizando e repetindo`);
                continue;
              }
              throw new Error(`Conflito de sincronização na coleção ${collectionName} do WhatsApp.`);
            }

            await authState.keys.set({ 'app-state-sync-version': { [collectionName]: nextState } });
            return { ok: true, version: nextState.version, signingKeyId, updatedExisting: Boolean(existingSlot) };
          } catch (err) {
            if (attempt === 0) {
              logWarn('appstate-write', `Tentativa 1 falhou em ${collectionName}, repetindo com resync limpo`, {
                err: err?.message
              });
              continue;
            }
            throw err;
          }
        }
      });
    };

    const nextPromise = this.appPatchChain.then(executeSerialized, executeSerialized);
    this.appPatchChain = nextPromise.catch(() => {});
    return nextPromise;
  }

  _resolveMatchingLabelDefinitions(requestedLabels = []) {
    const cleanRequested = Array.from(
      new Set((requestedLabels || []).map((l) => String(l || '').trim()).filter(Boolean))
    );
    const matched = [];
    const unmatched = [];
    if (cleanRequested.length === 0) return { matched, unmatched };

    const strip = (s) =>
      String(s || '')
        .trim()
        .toLowerCase()
        .replace(/^[\[#(\s]+|[\])\s]+$/g, '')
        .trim();

    const available = this.getAvailableLabels().filter((x) => x.id !== null);
    for (const reqName of cleanRequested) {
      const reqLower = reqName.toLowerCase();
      const reqCore = strip(reqLower);
      const hit = available.find((lbl) => {
        const lblLower = lbl.name.toLowerCase();
        const lblCore = strip(lblLower);
        return lblLower === reqLower || (reqCore.length >= 2 && lblCore === reqCore);
      });
      if (hit) {
        matched.push(hit);
      } else {
        unmatched.push(reqName);
      }
    }
    return { matched, unmatched };
  }

  /**
   * Salva efetivamente o contato no WhatsApp + Agenda do Celular (saveOnPrimaryAddressbook: true)
   * e aplica as Etiquetas / Listas personalizadas solicitadas.
   */
  async saveContactToWhatsApp({ jid, fullName, firstName = '', labels = [] }) {
    const check = validateContactSavePermission({
      phoneOrJid: jid,
      fullName,
      firstName,
      labels
    });
    if (!check.allowed) {
      throw new Error(check.error);
    }

    let targetJid = check.canonicalJid;
    let lidJid = check.lidJid || null;

    if (this.connectionStatus === 'demo_mode') {
      upsertDirectoryChat(targetJid, check.fullName, false, {
        nameSource: 'contact',
        lidJid
      });
      for (const lbl of check.labels) {
        updateSingleChatLabel(targetJid, lbl, true);
      }
      return {
        ok: true,
        mode: 'demo_mode',
        jid: targetJid,
        lidJid,
        displayPhone: check.displayPhone,
        fullName: check.fullName,
        firstName: check.firstName,
        appliedLabels: check.labels,
        unmatchedLabels: []
      };
    }

    if (this.connectionStatus !== 'connected' || !this.sock || !this.authState) {
      throw new Error(
        'O WhatsApp está desconectado no momento. Conecte o QR Code no Guardião para gravar na agenda do celular.'
      );
    }

    // Descobre/confirma o JID e o @lid oficial caso seja um número novo sem vínculo local
    if (!targetJid.endsWith('@lid') && !lidJid && typeof this.sock.onWhatsApp === 'function') {
      try {
        const lookup = await Promise.race([
          this.sock.onWhatsApp(targetJid),
          sleep(5000).then(() => null)
        ]);
        if (Array.isArray(lookup) && lookup.length > 0) {
          if (lookup[0].exists === false) {
            throw new Error(`O número ${check.displayPhone} não possui conta ativa no WhatsApp.`);
          }
          if (lookup[0].jid) {
            targetJid = normalizeChatJid(lookup[0].jid);
          }
          if (lookup[0].lid) {
            lidJid = normalizeChatJid(String(lookup[0].lid));
            this._linkLidAndPhone(lidJid, targetJid, check.fullName);
          }
        }
      } catch (lookupErr) {
        if (String(lookupErr?.message || '').includes('não possui conta ativa')) {
          throw lookupErr;
        }
      }
    }

    const contactActionPayload = {
      fullName: check.fullName,
      firstName: check.firstName,
      saveOnPrimaryAddressbook: true,
      ...(!targetJid.endsWith('@lid') ? { pnJid: targetJid } : {}),
      ...(lidJid ? { lidJid } : {})
    };

    await this.applySafeAppStatePatch({
      type: 'critical_unblock_low',
      index: ['contact', targetJid],
      syncAction: {
        timestamp: Date.now(),
        contactAction: contactActionPayload
      },
      apiVersion: 2,
      operation: proto.SyncdMutation.SyncdOperation.SET
    });

    const appliedLabels = [];
    let unmatchedLabels = [];

    if (check.labels.length > 0) {
      if (this.labelNamesById.size === 0 && !this.isSyncingAppState) {
        await this.syncContactsAndLabelsFromAppState({ silent: true }).catch(() => {});
      }

      const resolvedLabels = this._resolveMatchingLabelDefinitions(check.labels);
      unmatchedLabels = resolvedLabels.unmatched;

      for (const lbl of resolvedLabels.matched) {
        // Verifica se a conversa já tinha etiqueta associada pelo pnJid ou pelo lidJid
        let assocTarget = lidJid || targetJid;
        try {
          const regState = await this._syncCollectionLTHashState('regular');
          const keyIds = this._listAvailableAppStateKeyIds();
          const getAppStateSyncKey = async (keyId) => {
            const fetched = await this.authState.keys.get('app-state-sync-key', [keyId]);
            return fetched?.[keyId];
          };
          if (lidJid) {
            const hitLid = await this._findExistingKeyForIndex(
              ['label_jid', String(lbl.id), lidJid],
              regState,
              getAppStateSyncKey,
              keyIds
            );
            const hitPn = await this._findExistingKeyForIndex(
              ['label_jid', String(lbl.id), targetJid],
              regState,
              getAppStateSyncKey,
              keyIds
            );
            if (hitPn && !hitLid) {
              assocTarget = targetJid;
            } else {
              assocTarget = lidJid;
            }
          }
        } catch {
          // mantém assocTarget padrão
        }

        await this.applySafeAppStatePatch({
          type: 'regular',
          index: ['label_jid', String(lbl.id), assocTarget],
          syncAction: {
            timestamp: Date.now(),
            labelAssociationAction: {
              labeled: true
            }
          },
          apiVersion: 3,
          operation: proto.SyncdMutation.SyncdOperation.SET
        });

        updateSingleChatLabel(targetJid, lbl.name, true);
        appliedLabels.push(lbl.name);
      }
    }

    upsertDirectoryChat(targetJid, check.fullName, false, {
      nameSource: 'contact',
      lidJid: lidJid || null
    });

    this.autoFetchIfEmpty(targetJid);

    logInfo('appstate-write', 'Contato salvo com sucesso na agenda do WhatsApp + Celular', {
      jid: targetJid,
      fullName: check.fullName,
      appliedLabels
    });

    return {
      ok: true,
      mode: 'whatsapp_sync',
      jid: targetJid,
      lidJid,
      displayPhone: check.displayPhone,
      fullName: check.fullName,
      firstName: check.firstName,
      appliedLabels,
      unmatchedLabels
    };
  }

  async requestContactSaveFromAI({ phoneOrJid, fullName, firstName = '', labels = [], actor = 'IA (MCP)' }) {
    const settings = getSettings();
    if (!settings.aiEnabled) {
      addAuditLog({
        actor,
        action: 'salvar_contato',
        target: String(phoneOrJid || '-'),
        details: 'Bloqueado: Chave Geral da IA está Pausada',
        blocked: true
      });
      throw new Error('A chave geral da IA está PAUSADA no programa Guardião.');
    }

    const check = validateContactSavePermission({ phoneOrJid, fullName, firstName, labels });
    if (!check.allowed) {
      addAuditLog({
        actor,
        action: 'salvar_contato (Bloqueado)',
        target: check.canonicalJid || String(phoneOrJid || '-'),
        details: check.error,
        blocked: true
      });
      throw new Error(check.error);
    }

    const needsApproval = Boolean(settings.requireApprovalForContactsSave);

    if (needsApproval) {
      const queueId = enqueueContactSave({
        jid: check.canonicalJid,
        lidJid: check.lidJid,
        previousName: check.previousName,
        fullName: check.fullName,
        firstName: check.firstName,
        labels: check.labels,
        status: 'pending_approval',
        reason: 'Aguardando aprovação de 1 clique na tela do Guardião',
        actor
      });

      addAuditLog({
        actor,
        action: 'salvar_contato (Aguardando Aprovação)',
        target: check.displayPhone,
        details: `IA preparou contato "${check.fullName}" (${check.displayPhone})${
          check.labels.length ? ` · listas: ${check.labels.join(', ')}` : ''
        }`,
        blocked: false
      });

      return {
        queueId,
        status: 'pending_approval',
        jid: check.canonicalJid,
        displayPhone: check.displayPhone,
        previousName: check.previousName,
        fullName: check.fullName,
        firstName: check.firstName,
        labels: check.labels,
        message: `Contato "${check.fullName}" (${check.displayPhone}) colocado na fila de aprovação. Basta clicar em [Salvar na agenda] (ou [Aprovar todos]) na janela do Guardião.`
      };
    }

    // Modo direto (requireApprovalForContactsSave === false)
    const saved = await this.saveContactToWhatsApp({
      jid: check.canonicalJid,
      fullName: check.fullName,
      firstName: check.firstName,
      labels: check.labels
    });

    const queueId = enqueueContactSave({
      jid: saved.jid,
      lidJid: saved.lidJid,
      previousName: check.previousName,
      fullName: saved.fullName,
      firstName: saved.firstName,
      labels: saved.appliedLabels.length > 0 ? saved.appliedLabels : check.labels,
      status: 'saved',
      reason: 'Salvo diretamente na agenda do WhatsApp + Celular',
      actor,
      appliedAt: Date.now()
    });

    addAuditLog({
      actor,
      action: 'salvar_contato (Salvo na Agenda)',
      target: saved.displayPhone,
      details: `IA salvou "${saved.fullName}" (${saved.displayPhone}) na agenda do WhatsApp + Celular`,
      blocked: false
    });

    return {
      queueId,
      status: 'saved',
      ...saved,
      message: `Contato "${saved.fullName}" (${saved.displayPhone}) salvo com sucesso na agenda do WhatsApp e do celular!`
    };
  }

  async requestContactSaveBatchFromAI(contacts = [], actor = 'IA (MCP)') {
    const settings = getSettings();
    if (!settings.aiEnabled) {
      throw new Error('A chave geral da IA está PAUSADA no programa Guardião.');
    }
    if (!Array.isArray(contacts) || contacts.length === 0) {
      throw new Error('Informe ao menos 1 contato na lista "contacts".');
    }

    const capped = contacts.slice(0, 30);
    const results = [];
    let queuedCount = 0;
    let savedCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < capped.length; i++) {
      const item = capped[i] || {};
      try {
        const res = await this.requestContactSaveFromAI({
          phoneOrJid: item.phoneOrJid || item.jid || item.phone,
          fullName: item.fullName || item.name,
          firstName: item.firstName || '',
          labels: item.labels || [],
          actor
        });
        if (res.status === 'pending_approval') queuedCount += 1;
        if (res.status === 'saved') {
          savedCount += 1;
          if (i < capped.length - 1) await sleep(250);
        }
        results.push({ ok: true, ...res });
      } catch (err) {
        rejectedCount += 1;
        results.push({
          ok: false,
          phoneOrJid: item.phoneOrJid || item.jid || item.phone || '',
          fullName: item.fullName || item.name || '',
          error: err?.message || 'Falha ao processar contato'
        });
      }
    }

    return {
      totalProcessed: capped.length,
      truncatedFrom: contacts.length > 30 ? contacts.length : undefined,
      queuedCount,
      savedCount,
      rejectedCount,
      summary:
        queuedCount > 0
          ? `${queuedCount} contato(s) prontos para revisão no Guardião (você pode clicar em "Aprovar todos os contatos" de uma só vez).`
          : `${savedCount} contato(s) salvos diretamente na agenda do WhatsApp + Celular.`,
      results
    };
  }

  async approveContactSave(id, { fullName = null, labels = null } = {}) {
    const item = getContactSaveItemById(id);
    if (!item) {
      throw new Error('Item da fila de contatos não encontrado.');
    }

    const finalFullName = fullName !== null && String(fullName).trim() ? String(fullName).trim() : item.full_name;
    const finalFirstName = extractFirstNameFromFullName(finalFullName);
    const finalLabels = Array.isArray(labels) ? labels : item.labels;

    try {
      const saved = await this.saveContactToWhatsApp({
        jid: item.jid,
        fullName: finalFullName,
        firstName: finalFirstName,
        labels: finalLabels
      });

      const updated = updateContactSaveItem(item.id, {
        full_name: saved.fullName,
        first_name: saved.firstName,
        labels: saved.appliedLabels.length > 0 ? saved.appliedLabels : finalLabels,
        lid_jid: saved.lidJid || item.lid_jid,
        status: 'saved',
        reason: 'Salvo na agenda do WhatsApp + Celular',
        applied_at: Date.now()
      });

      addAuditLog({
        actor: 'Usuário / App',
        action: 'aprovar_contato',
        target: saved.displayPhone,
        details: `Aprovou e salvou "${saved.fullName}" (${saved.displayPhone}) na agenda`,
        blocked: false
      });

      return updated;
    } catch (err) {
      const isDisconnected = String(err?.message || '').toLowerCase().includes('desconectado');
      const rawMsg = String(err?.message || '');
      const friendlyMsg = /tried remove|LTHash|patch mac|HMAC/i.test(rawMsg)
        ? 'Divergência temporária na sincronização da agenda do WhatsApp. Clique em "Tentar novamente".'
        : rawMsg || 'Erro ao gravar contato no WhatsApp';
      // Se o WhatsApp estiver apenas desconectado, mantém o item pendente para o usuário não perder o lote!
      updateContactSaveItem(item.id, {
        full_name: finalFullName,
        first_name: finalFirstName,
        status: isDisconnected ? 'pending_approval' : 'failed',
        reason: friendlyMsg
      });
      throw err;
    }
  }

  async approveAllPendingContactSaves() {
    const pending = getPendingContactSaveItems();
    if (pending.length === 0) {
      return { ok: true, savedCount: 0, failedCount: 0, message: 'Nenhum contato pendente na fila.' };
    }

    let savedCount = 0;
    let failedCount = 0;
    let lastError = '';

    for (let i = 0; i < pending.length; i++) {
      try {
        await this.approveContactSave(pending[i].id);
        savedCount += 1;
        if (i < pending.length - 1) {
          await sleep(250);
        }
      } catch (err) {
        failedCount += 1;
        lastError = err?.message || 'Erro ao salvar';
        if (String(lastError).toLowerCase().includes('desconectado')) {
          break;
        }
      }
    }

    return {
      ok: savedCount > 0 || failedCount === 0,
      savedCount,
      failedCount,
      lastError: lastError || null,
      message:
        failedCount === 0
          ? `${savedCount} contato(s) salvos com sucesso na agenda do WhatsApp + Celular!`
          : savedCount > 0
          ? `${savedCount} salvo(s), ${failedCount} com pendência (${lastError}).`
          : lastError
    };
  }

  rejectContactSave(id) {
    return updateContactSaveItem(id, {
      status: 'rejected',
      reason: 'Recusado manualmente pelo usuário'
    });
  }

  rejectAllPendingContacts() {
    const count = rejectAllPendingContactSaves();
    return { rejectedCount: count };
  }

  async processOutboxQueue() {
    if (this.isProcessingQueue || this.connectionStatus === 'connecting') return;
    const nextItem = getNextQueuedOutboxItem();
    if (!nextItem) return;

    const settings = getSettings();
    const minDelaySec = Math.max(Number(settings.minDelaySeconds) || 25, 5);
    const maxDelaySec = Math.max(Number(settings.maxDelaySeconds) || 45, minDelaySec + 5);
    if (!this.currentTargetGapMs) {
      this.currentTargetGapMs = Math.floor(
        (minDelaySec + Math.random() * (maxDelaySec - minDelaySec)) * 1000
      );
    }

    const elapsedSinceLast =
      this.lastSentMonotonic > 0 ? performance.now() - this.lastSentMonotonic : Infinity;
    if (this.lastSentMonotonic > 0 && elapsedSinceLast < this.currentTargetGapMs) {
      const remainingSec = Math.max(1, Math.ceil((this.currentTargetGapMs - elapsedSinceLast) / 1000));
      updateOutboxItem(nextItem.id, {
        reason: `Intervalo Anti-Banimento: enviando em ~${remainingSec}s...`
      });
      return;
    }

    this.isProcessingQueue = true;
    try {
      updateOutboxItem(nextItem.id, {
        status: 'sending_typing',
        reason: 'Simulando leitura e status "Digitando..." no WhatsApp...'
      });

      const typingDurationMs = settings.simulateTyping
        ? Math.min(Math.max(nextItem.content.length * 45, 2500), 6500)
        : 500;

      if (this.connectionStatus === 'connected' && this.sock) {
        try {
          try {
            await this.sock.sendPresenceUpdate('available', nextItem.jid);
            await sleep(1500);
            if (settings.simulateTyping) {
              await this.sock.sendPresenceUpdate('composing', nextItem.jid);
              await sleep(typingDurationMs);
              await this.sock.sendPresenceUpdate('paused', nextItem.jid);
            }
          } catch {
            // Presença "digitando" nunca deve impedir o envio caso o contato use @lid sem me.lid
            if (settings.simulateTyping) await sleep(Math.min(typingDurationMs, 2500));
          }
          await this.sock.sendMessage(nextItem.jid, { text: nextItem.content });
        } catch (sendErr) {
          updateOutboxItem(nextItem.id, {
            status: 'failed',
            reason: `Falha ao enviar: ${sendErr?.message || 'Erro de conexão'}`
          });
          this.isProcessingQueue = false;
          return;
        }
      } else if (this.connectionStatus === 'demo_mode') {
        await sleep(Math.min(typingDurationMs, 3000));
      } else {
        updateOutboxItem(nextItem.id, {
          status: 'failed',
          reason: 'WhatsApp desconectado no momento do envio. Conecte o QR Code ou ative o Modo Demo.'
        });
        this.isProcessingQueue = false;
        return;
      }

      this.lastSentMonotonic = performance.now();
      this.lastSentTimestamp = Date.now();
      this.currentTargetGapMs = 0;
      updateOutboxItem(nextItem.id, {
        status: 'sent',
        sent_at: this.lastSentTimestamp,
        reason: 'Enviado com segurança (Humanizer concluído)'
      });

      ingestFilteredMessage({
        id: `out_${nextItem.id}_${this.lastSentTimestamp}`,
        jid: nextItem.jid,
        chatName: nextItem.chat_name,
        senderName: 'Eu (via IA)',
        fromMe: true,
        content: nextItem.content,
        timestamp: this.lastSentTimestamp,
        nameSource: 'contact'
      });
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Modo Demonstração Interativo (Permite testar filtros, tags, bloqueio privado e fila sem celular)
   */
  activateDemoMode() {
    this.manualDisconnect = true;
    this._disposeSocket();
    this.qrDataUrl = null;
    this.pairingMessage = null;
    this.lastError = null;
    this.connectionStatus = 'demo_mode';
    this.connectedUser = {
      id: '5511999999999@s.whatsapp.net',
      name: 'Ambiente de Exemplo'
    };

    upsertDirectoryChat('120363001@g.us', 'Comercial & Vendas', true, { nameSource: 'contact' });
    setChatExplicitPermission('120363001@g.us', true);

    upsertDirectoryChat('120363002@g.us', 'Operações e Entregas', true, { nameSource: 'contact' });
    setChatExplicitPermission('120363002@g.us', true);

    upsertDirectoryChat('120363999@g.us', 'Futebol de Quarta', true, { nameSource: 'contact' });

    upsertDirectoryChat('5511988881111@s.whatsapp.net', 'Carlos Mendes [EMP]', false, {
      nameSource: 'contact'
    });
    upsertDirectoryChat('5511988882222@s.whatsapp.net', 'Fernanda Alves #emp', false, {
      nameSource: 'contact'
    });

    upsertDirectoryChat('5511977770001@s.whatsapp.net', 'Mãe', false, { nameSource: 'contact' });
    upsertDirectoryChat('5511977770002@s.whatsapp.net', 'Dr. Roberto Clínica', false, {
      nameSource: 'contact'
    });

    const now = Date.now();

    const demoMessages = [
      {
        id: 'demo_1',
        jid: '120363001@g.us',
        chatName: 'Comercial & Vendas',
        senderName: 'Marcos',
        fromMe: false,
        content: 'Pessoal, precisamos enviar a proposta revisada para o Carlos Mendes hoje com os 10% de desconto aprovados.',
        timestamp: now - 3600 * 1000,
        nameSource: 'contact'
      },
      {
        id: 'demo_2',
        jid: '120363001@g.us',
        chatName: 'Comercial & Vendas',
        senderName: 'Ana',
        fromMe: false,
        content: 'Combinado. O prazo de implantação ficou em 15 dias úteis após a assinatura.',
        timestamp: now - 3200 * 1000,
        nameSource: 'contact'
      },
      {
        id: 'demo_3',
        jid: '5511988881111@s.whatsapp.net',
        chatName: 'Carlos Mendes [EMP]',
        senderName: 'Carlos Mendes',
        fromMe: false,
        content: 'Oi! Vocês conseguiram validar o desconto de 10% e o prazo de implantação que conversamos ontem?',
        timestamp: now - 1800 * 1000,
        nameSource: 'contact'
      },
      {
        id: 'demo_4',
        jid: '120363002@g.us',
        chatName: 'Operações e Entregas',
        senderName: 'Lucas',
        fromMe: false,
        content: 'O pedido #402 da Fernanda Alves chegou no estoque às 14h sem pendências.',
        timestamp: now - 900 * 1000,
        nameSource: 'contact'
      },
      {
        id: 'demo_priv_1',
        jid: '5511977770001@s.whatsapp.net',
        chatName: 'Mãe',
        senderName: 'Mãe',
        fromMe: false,
        content: 'Filho, passa aqui em casa domingo para almoçar!',
        timestamp: now - 600 * 1000,
        nameSource: 'contact'
      },
      {
        id: 'demo_priv_2',
        jid: '120363999@g.us',
        chatName: 'Futebol de Quarta',
        senderName: 'Rodrigo',
        fromMe: false,
        content: 'Quem vai no churrasco depois do jogo?',
        timestamp: now - 300 * 1000,
        nameSource: 'contact'
      }
    ];

    for (const m of demoMessages) {
      const res = ingestFilteredMessage(m);
      if (res.stored) {
        this.sessionStats.storedMessages += 1;
      } else {
        this.sessionStats.discardedPrivateMessages += 1;
      }
    }

    return this.getStatus();
  }
}

function toTimestampMs(raw) {
  if (!raw) return Date.now();
  let n = 0;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw.toNumber === 'function') {
    n = raw.toNumber();
  } else if (typeof raw.low === 'number') {
    n = raw.low;
  } else {
    n = Number(raw) || 0;
  }
  if (!n || Number.isNaN(n)) return Date.now();
  return n > 1e12 ? n : n * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const whatsappService = new WhatsAppGuardService();
