import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR =
  process.env.GUARDIAO_DATA_DIR ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GuardiaoWhatsApp')
    : path.join(os.homedir(), '.guardiao-whatsapp'));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'guardiao.sqlite');
const db = new DatabaseSync(DB_PATH);

// Inicializa tabelas
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS directory_chats (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_group INTEGER NOT NULL DEFAULT 0,
    explicitly_allowed INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL DEFAULT 0,
    latest_msg_id TEXT DEFAULT NULL,
    latest_from_me INTEGER DEFAULT 0,
    latest_timestamp INTEGER DEFAULT 0,
    latest_raw_jid TEXT DEFAULT NULL,
    name_source TEXT DEFAULT 'unknown',
    lid_jid TEXT DEFAULT NULL,
    labels_json TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    jid TEXT NOT NULL,
    chat_name TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    from_me INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_jid_time ON messages(jid, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(timestamp DESC);

  CREATE TABLE IF NOT EXISTS outbox_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    chat_name TEXT NOT NULL,
    is_group INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    status TEXT NOT NULL, -- 'pending_approval' | 'queued' | 'sending_typing' | 'sent' | 'rejected' | 'failed'
    reason TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    sent_at INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    details TEXT NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS whatsapp_labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contact_save_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    lid_jid TEXT DEFAULT NULL,
    previous_name TEXT DEFAULT '',
    full_name TEXT NOT NULL,
    first_name TEXT NOT NULL,
    labels_json TEXT DEFAULT '[]',
    status TEXT NOT NULL, -- 'pending_approval' | 'saved' | 'rejected' | 'failed'
    reason TEXT DEFAULT '',
    actor TEXT DEFAULT 'IA (MCP)',
    created_at INTEGER NOT NULL,
    applied_at INTEGER DEFAULT NULL
  );
`);

// Migração segura para bancos já existentes (sem apagar filtros do usuário)
for (const colDef of [
  'latest_msg_id TEXT DEFAULT NULL',
  'latest_from_me INTEGER DEFAULT 0',
  'latest_timestamp INTEGER DEFAULT 0',
  'latest_raw_jid TEXT DEFAULT NULL',
  "name_source TEXT DEFAULT 'unknown'",
  'lid_jid TEXT DEFAULT NULL',
  "labels_json TEXT DEFAULT '[]'"
]) {
  try {
    db.exec(`ALTER TABLE directory_chats ADD COLUMN ${colDef}`);
  } catch {
    // coluna já existe
  }
}

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_directory_chats_lid ON directory_chats(lid_jid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contact_save_status ON contact_save_queue(status, created_at DESC)');
} catch {
  // ignora
}

const DEFAULT_SETTINGS = {
  aiEnabled: true,
  allowedTags: ['[EMP]', '#emp', '[Trabalho]', '#work'],
  requireApprovalForContacts: true,
  requireApprovalForGroups: false,
  requireApprovalForContactsSave: true,
  maxMessagesPerHour: 15,
  minDelaySeconds: 25,
  maxDelaySeconds: 45,
  simulateTyping: true,
  blockDuplicateMessages: true,
  mcpHttpToken: '',
  webTunnelEnabled: false,
  customTunnelToken: ''
};

const PT_COLLATOR = new Intl.Collator('pt-BR', { sensitivity: 'base' });
let directoryChatsCache = null;
let txDepth = 0;

export function invalidateChatsCache() {
  directoryChatsCache = null;
}

export function runInTransaction(fn) {
  if (txDepth > 0) {
    return fn();
  }
  txDepth += 1;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    directoryChatsCache = null;
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignora
    }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

export function normalizeChatJid(rawJid) {
  if (!rawJid || typeof rawJid !== 'string') return '';
  const trimmed = rawJid.trim();
  if (!trimmed) return '';
  if (trimmed.endsWith('@g.us') || trimmed.endsWith('@broadcast') || trimmed.endsWith('@newsletter')) {
    return trimmed;
  }
  const [userPart, domainPart] = trimmed.split('@');
  if (!domainPart) return trimmed;
  const cleanUser = userPart.split(':')[0];
  const cleanDomain = domainPart === 'c.us' ? 's.whatsapp.net' : domainPart;
  return `${cleanUser}@${cleanDomain}`;
}

export function resolveCanonicalJid(rawJid) {
  const norm = normalizeChatJid(rawJid);
  if (!norm) return '';
  if (norm.endsWith('@lid')) {
    const mapped = db
      .prepare('SELECT jid FROM directory_chats WHERE lid_jid = ? AND jid != ? LIMIT 1')
      .get(norm, norm);
    if (mapped?.jid) return mapped.jid;
  }
  return norm;
}

function parseLabelsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

function stripTagDecorators(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/^[\[#(\s]+|[\])\s]+$/g, '')
    .trim();
}

function isBareIdName(name, jid) {
  if (!name) return true;
  const clean = String(name).trim();
  if (!clean) return true;
  const userPart = (jid || '').split('@')[0];
  if (clean === userPart || clean === `+${userPart}`) return true;
  return /^\+?\d[\d\s-]{6,24}$/.test(clean);
}

function formatPhoneDisplay(rawDigits) {
  const digits = String(rawDigits || '').replace(/\D/g, '');
  if (!digits) return rawDigits || '';
  const br13 = digits.match(/^55(\d{2})(\d{5})(\d{4})$/);
  if (br13) return `+55 ${br13[1]} ${br13[2]}-${br13[3]}`;
  const br12 = digits.match(/^55(\d{2})(\d{4})(\d{4})$/);
  if (br12) return `+55 ${br12[1]} ${br12[2]}-${br12[3]}`;
  return `+${digits}`;
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const current = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    try {
      current[row.key] = JSON.parse(row.value);
    } catch {
      current[row.key] = row.value;
    }
  }
  if (!current.mcpHttpToken || String(current.mcpHttpToken).length < 24) {
    const generated = crypto.randomBytes(24).toString('hex');
    current.mcpHttpToken = generated;
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('mcpHttpToken', JSON.stringify(generated));
  }
  return current;
}

export function rotateMcpHttpToken() {
  const nextToken = crypto.randomBytes(24).toString('hex');
  return updateSettings({ mcpHttpToken: nextToken });
}

export function updateSettings(partial) {
  const current = getSettings();
  const next = { ...current, ...partial };
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(next)) {
    stmt.run(k, JSON.stringify(v));
  }
  directoryChatsCache = null;
  return next;
}

export function getChatBasicInfo(jid) {
  const canonicalJid = resolveCanonicalJid(jid);
  if (!canonicalJid) return null;
  const row = db
    .prepare(
      'SELECT jid, name, name_source, latest_msg_id FROM directory_chats WHERE jid = ?'
    )
    .get(canonicalJid);
  if (!row) return null;
  return {
    jid: row.jid,
    name: row.name,
    nameSource: row.name_source || 'unknown',
    hasHistoryCursor: Boolean(row.latest_msg_id)
  };
}

/**
 * Verifica se um contato/grupo possui alguma das tags autorizadas no nome
 * OU em uma Etiqueta / Lista personalizada do WhatsApp (ex: [EMP]).
 */
export function matchChatTagDetails(name, labels = [], tags = null) {
  const activeTags = (tags || getSettings().allowedTags || [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  if (activeTags.length === 0) {
    return { matched: false, byName: false, byLabel: false, matchedLabel: null };
  }

  const lowerName = String(name || '').toLowerCase();
  const byName = Boolean(
    lowerName && activeTags.some((t) => lowerName.includes(t.toLowerCase()))
  );

  let matchedLabel = null;
  if (Array.isArray(labels) && labels.length > 0) {
    for (const label of labels) {
      const lowerLabel = String(label || '').trim().toLowerCase();
      if (!lowerLabel) continue;
      const coreLabel = stripTagDecorators(lowerLabel);
      const hit = activeTags.some((t) => {
        const lowerTag = t.toLowerCase();
        const coreTag = stripTagDecorators(lowerTag);
        if (lowerLabel === lowerTag || lowerLabel.includes(lowerTag)) return true;
        if (coreTag.length >= 2 && coreLabel === coreTag) return true;
        return false;
      });
      if (hit) {
        matchedLabel = label;
        break;
      }
    }
  }

  return {
    matched: byName || Boolean(matchedLabel),
    byName,
    byLabel: Boolean(matchedLabel),
    matchedLabel
  };
}

export function hasAllowedTag(name, tags = null, labels = []) {
  return matchChatTagDetails(name, labels, tags).matched;
}

/**
 * Verifica se um chat (JID) está autorizado a ter mensagens salvas ou lidas pela IA.
 * Regra:
 * 1) Está marcado manualmente (explicitly_allowed = 1) na tela, OU
 * 2) O nome do contato/grupo contém uma das tags configuradas (ex: [EMP], [CLIENTE]), OU
 * 3) A conversa está marcada no WhatsApp com uma Lista/Etiqueta correspondente à tag (ex: [EMP])
 */
export function isChatAuthorized(jid, fallbackName = '') {
  const canonicalJid = resolveCanonicalJid(jid);
  const row = db
    .prepare('SELECT jid, name, explicitly_allowed, labels_json FROM directory_chats WHERE jid = ?')
    .get(canonicalJid);
  const nameToCheck = row?.name || fallbackName || '';
  const labels = parseLabelsJson(row?.labels_json);

  if (row && row.explicitly_allowed === 1) {
    return { allowed: true, reason: 'Marcado manualmente na lista', name: nameToCheck, canonicalJid };
  }

  const tagMatch = matchChatTagDetails(nameToCheck, labels);
  if (tagMatch.matched) {
    return {
      allowed: true,
      reason: tagMatch.byLabel
        ? `Possui Etiqueta/Lista "${tagMatch.matchedLabel}" no WhatsApp`
        : 'Possui Tag autorizada no nome',
      name: nameToCheck,
      canonicalJid
    };
  }

  return {
    allowed: false,
    reason: 'Conversa privada (sem Tag e não selecionada)',
    name: nameToCheck,
    canonicalJid
  };
}

/**
 * Unifica um registro @lid com seu número real @s.whatsapp.net quando o WhatsApp revela o vínculo,
 * preservando nome salvo na agenda, permissões, etiquetas, cursores de histórico e mensagens.
 */
export function mergeLidIntoPhoneChat(lidJid, pnJid, contactName = '') {
  const normLid = normalizeChatJid(lidJid);
  const normPn = normalizeChatJid(pnJid);
  if (!normLid || !normPn || normLid === normPn) return normPn || normLid;
  if (!normLid.endsWith('@lid') || normPn.endsWith('@lid')) return normPn;

  const lidRow = db.prepare('SELECT * FROM directory_chats WHERE jid = ?').get(normLid);
  const pnRow = db.prepare('SELECT * FROM directory_chats WHERE jid = ?').get(normPn);

  const cleanContactName = (contactName || '').trim();
  const hasAuthoritativeArg = cleanContactName && !isBareIdName(cleanContactName, normPn);

  let bestName = '';
  let bestSource = 'unknown';

  if (hasAuthoritativeArg) {
    bestName = cleanContactName;
    bestSource = 'contact';
  } else if (pnRow?.name_source === 'contact' && !isBareIdName(pnRow.name, normPn)) {
    bestName = pnRow.name;
    bestSource = 'contact';
  } else if (lidRow?.name_source === 'contact' && !isBareIdName(lidRow.name, normLid)) {
    bestName = lidRow.name;
    bestSource = 'contact';
  } else if (pnRow && !isBareIdName(pnRow.name, normPn)) {
    bestName = pnRow.name;
    bestSource = pnRow.name_source || 'unknown';
  } else if (lidRow && !isBareIdName(lidRow.name, normLid)) {
    bestName = lidRow.name;
    bestSource = lidRow.name_source || 'unknown';
  } else {
    bestName = cleanContactName || pnRow?.name || normPn.split('@')[0];
  }

  const explicitlyAllowed =
    pnRow?.explicitly_allowed === 1 || lidRow?.explicitly_allowed === 1 ? 1 : 0;
  const lastSeen = Math.max(pnRow?.last_seen || 0, lidRow?.last_seen || 0, Date.now());

  const mergedLabels = Array.from(
    new Set([...parseLabelsJson(pnRow?.labels_json), ...parseLabelsJson(lidRow?.labels_json)])
  );

  // Escolhe o cursor opaco mais recente disponível entre os dois registros
  let anchor = {
    msgId: pnRow?.latest_msg_id || null,
    fromMe: pnRow?.latest_from_me || 0,
    ts: pnRow?.latest_timestamp || 0,
    rawJid: pnRow?.latest_raw_jid || null
  };
  if (
    lidRow?.latest_msg_id &&
    (!anchor.msgId || (lidRow.latest_timestamp || 0) >= (anchor.ts || 0))
  ) {
    anchor = {
      msgId: lidRow.latest_msg_id,
      fromMe: lidRow.latest_from_me || 0,
      ts: lidRow.latest_timestamp || 0,
      rawJid: lidRow.latest_raw_jid || normLid
    };
  }

  if (!pnRow) {
    db.prepare(`
      INSERT INTO directory_chats (
        jid, name, is_group, explicitly_allowed, last_seen,
        latest_msg_id, latest_from_me, latest_timestamp, latest_raw_jid,
        name_source, lid_jid, labels_json
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normPn,
      bestName,
      explicitlyAllowed,
      lastSeen,
      anchor.msgId,
      anchor.fromMe,
      anchor.ts,
      anchor.rawJid,
      bestSource,
      normLid,
      JSON.stringify(mergedLabels)
    );
  } else {
    db.prepare(`
      UPDATE directory_chats
      SET name = ?, explicitly_allowed = ?, last_seen = ?,
          latest_msg_id = ?, latest_from_me = ?, latest_timestamp = ?, latest_raw_jid = ?,
          name_source = ?, lid_jid = ?, labels_json = ?
      WHERE jid = ?
    `).run(
      bestName,
      explicitlyAllowed,
      lastSeen,
      anchor.msgId,
      anchor.fromMe,
      anchor.ts,
      anchor.rawJid,
      bestSource,
      normLid,
      JSON.stringify(mergedLabels),
      normPn
    );
  }

  if (lidRow) {
    db.prepare('UPDATE messages SET jid = ?, chat_name = ? WHERE jid = ?').run(normPn, bestName, normLid);
    db.prepare('UPDATE outbox_queue SET jid = ?, chat_name = ? WHERE jid = ?').run(normPn, bestName, normLid);
    db.prepare('UPDATE contact_save_queue SET jid = ?, lid_jid = ? WHERE jid = ?').run(normPn, normLid, normLid);
    db.prepare('DELETE FROM directory_chats WHERE jid = ?').run(normLid);
  }

  directoryChatsCache = null;
  return normPn;
}

/**
 * Atualiza o catálogo visual de grupos/contatos (sem salvar mensagens privadas!).
 * nameSource: 'contact' (agenda salva do celular / assunto do grupo) | 'push' (nome público do perfil) | 'unknown'
 * Nomes 'push' NUNCA sobrescrevem nomes 'contact' salvos na agenda (ex: "Mariana [Fornecedor] [EMP]").
 */
export function upsertDirectoryChat(jid, name, isGroup, options = {}) {
  const normInputJid = normalizeChatJid(jid);
  if (
    !normInputJid ||
    normInputJid === 'status@broadcast' ||
    normInputJid.endsWith('@broadcast') ||
    normInputJid.endsWith('@newsletter')
  ) {
    return;
  }

  const nameSource = options.nameSource || 'unknown';
  const normLid = options.lidJid ? normalizeChatJid(options.lidJid) : null;

  // Se recebemos juntos o número @s.whatsapp.net e o @lid do contato, unifica imediatamente
  if (normLid && normLid.endsWith('@lid') && !normInputJid.endsWith('@lid') && !isGroup) {
    mergeLidIntoPhoneChat(normLid, normInputJid, nameSource === 'contact' ? name : '');
  }

  const targetJid = isGroup ? normInputJid : resolveCanonicalJid(normInputJid);
  const cleanName = (name || targetJid.split('@')[0]).trim();
  const incomingHasRealName = !isBareIdName(cleanName, targetJid) && !isBareIdName(cleanName, normInputJid);

  const existing = db
    .prepare('SELECT name, explicitly_allowed, name_source, lid_jid FROM directory_chats WHERE jid = ?')
    .get(targetJid);
  const now = Date.now();

  if (!existing) {
    const initialSource = incomingHasRealName ? nameSource : 'unknown';
    db.prepare(`
      INSERT INTO directory_chats (
        jid, name, is_group, explicitly_allowed, last_seen, name_source, lid_jid
      ) VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(
      targetJid,
      cleanName || targetJid.split('@')[0],
      isGroup ? 1 : 0,
      now,
      initialSource,
      normLid && normLid.endsWith('@lid') ? normLid : null
    );
    directoryChatsCache = null;
    return;
  }

  let nextName = existing.name;
  let nextSource = existing.name_source || 'unknown';

  if (nameSource === 'contact' && incomingHasRealName) {
    // Nome salvo na agenda ou nome oficial do grupo sempre tem prioridade máxima
    nextName = cleanName;
    nextSource = 'contact';
  } else if (existing.name_source === 'contact' && !isBareIdName(existing.name, targetJid)) {
    // Protege o nome da agenda contra sobrescrita por pushName (ex: "Mariana" não apaga "Mariana [Fornecedor] [EMP]")
    nextName = existing.name;
    nextSource = 'contact';
  } else if (incomingHasRealName) {
    if (isBareIdName(existing.name, targetJid) || nameSource !== 'push') {
      nextName = cleanName;
      nextSource = nameSource;
    } else if (existing.name_source !== 'contact') {
      nextName = cleanName;
      nextSource = nameSource;
    }
  }

  const nextLid =
    (normLid && normLid.endsWith('@lid') ? normLid : null) || existing.lid_jid || null;

  if (
    nextName === existing.name &&
    nextSource === (existing.name_source || 'unknown') &&
    nextLid === (existing.lid_jid || null)
  ) {
    return;
  }

  db.prepare(`
    UPDATE directory_chats
    SET name = ?, is_group = ?, last_seen = ?, name_source = ?, lid_jid = ?
    WHERE jid = ?
  `).run(nextName, isGroup ? 1 : 0, now, nextSource, nextLid, targetJid);

  if (nextName !== existing.name && nextSource === 'contact') {
    db.prepare('UPDATE messages SET chat_name = ? WHERE jid = ?').run(nextName, targetJid);
  }
  directoryChatsCache = null;
}

export function setChatLabels(jid, labelNames = []) {
  const targetJid = resolveCanonicalJid(jid);
  if (
    !targetJid ||
    targetJid === 'status@broadcast' ||
    targetJid.endsWith('@broadcast') ||
    targetJid.endsWith('@newsletter')
  ) {
    return;
  }
  const cleanLabels = Array.from(
    new Set((labelNames || []).map((l) => String(l || '').trim()).filter(Boolean))
  );
  const existing = db.prepare('SELECT jid FROM directory_chats WHERE jid = ?').get(targetJid);
  if (!existing) {
    upsertDirectoryChat(targetJid, targetJid.split('@')[0], targetJid.endsWith('@g.us'), {
      nameSource: 'unknown'
    });
  }
  db.prepare('UPDATE directory_chats SET labels_json = ? WHERE jid = ?').run(
    JSON.stringify(cleanLabels),
    targetJid
  );
  directoryChatsCache = null;
}

export function updateSingleChatLabel(jid, labelName, isLabeled) {
  const targetJid = resolveCanonicalJid(jid);
  if (!targetJid || !labelName) return;
  const row = db.prepare('SELECT labels_json FROM directory_chats WHERE jid = ?').get(targetJid);
  const current = new Set(parseLabelsJson(row?.labels_json));
  if (isLabeled) {
    current.add(String(labelName).trim());
  } else {
    current.delete(String(labelName).trim());
  }
  setChatLabels(targetJid, Array.from(current));
}

export function replaceAllChatLabelsFromSync(chatLabelsMap) {
  runInTransaction(() => {
    db.prepare("UPDATE directory_chats SET labels_json = '[]'").run();
    for (const [rawJid, labelSet] of chatLabelsMap.entries()) {
      const arr = Array.from(labelSet || []).filter(Boolean);
      if (arr.length > 0) {
        setChatLabels(rawJid, arr);
      }
    }
  });
  directoryChatsCache = null;
}

export function setChatExplicitPermission(jid, allowed) {
  const targetJid = resolveCanonicalJid(jid);
  db.prepare('UPDATE directory_chats SET explicitly_allowed = ? WHERE jid = ?').run(
    allowed ? 1 : 0,
    targetJid
  );
  directoryChatsCache = null;
  return getDirectoryChats();
}

export function updateChatLatestAnchor(jid, { msgId, fromMe, timestampMs, rawJid }) {
  const targetJid = resolveCanonicalJid(jid);
  if (
    !targetJid ||
    !msgId ||
    targetJid === 'status@broadcast' ||
    targetJid.endsWith('@broadcast') ||
    targetJid.endsWith('@newsletter')
  ) {
    return;
  }
  const ts = Number(timestampMs) || Date.now();
  const row = db
    .prepare('SELECT latest_timestamp, latest_msg_id FROM directory_chats WHERE jid = ?')
    .get(targetJid);

  if (!row) {
    upsertDirectoryChat(targetJid, targetJid.split('@')[0], targetJid.endsWith('@g.us'), {
      nameSource: 'unknown'
    });
  }

  if (!row || !row.latest_msg_id || ts >= (row.latest_timestamp || 0)) {
    const hadCursorBefore = Boolean(row?.latest_msg_id);
    db.prepare(`
      UPDATE directory_chats
      SET latest_msg_id = ?, latest_from_me = ?, latest_timestamp = ?, latest_raw_jid = ?
      WHERE jid = ?
    `).run(msgId, fromMe ? 1 : 0, ts, rawJid || jid, targetJid);
    if (!hadCursorBefore) {
      directoryChatsCache = null;
    }
  }
}

export function getHistoryCursorForChat(jid) {
  const targetJid = resolveCanonicalJid(jid);
  const dirRow = db
    .prepare(
      'SELECT latest_msg_id, latest_from_me, latest_timestamp, latest_raw_jid, lid_jid FROM directory_chats WHERE jid = ?'
    )
    .get(targetJid);

  const oldestStored = db.prepare(`
    SELECT id, from_me, timestamp
    FROM messages
    WHERE jid = ? AND id NOT LIKE 'out_%' AND id NOT LIKE 'sim_%' AND id NOT LIKE 'demo_%'
    ORDER BY timestamp ASC
    LIMIT 1
  `).get(targetJid);

  if (oldestStored) {
    return {
      msgId: oldestStored.id,
      fromMe: oldestStored.from_me === 1,
      timestampMs: oldestStored.timestamp,
      rawJid: dirRow?.latest_raw_jid || targetJid,
      mode: 'older_than_stored'
    };
  }

  if (dirRow?.latest_msg_id) {
    return {
      msgId: dirRow.latest_msg_id,
      fromMe: dirRow.latest_from_me === 1,
      timestampMs: (dirRow.latest_timestamp || Date.now()) + 1000,
      rawJid: dirRow.latest_raw_jid || targetJid,
      mode: 'recent_from_latest_anchor'
    };
  }

  return null;
}

export function getDirectoryChats() {
  if (directoryChatsCache) {
    return directoryChatsCache;
  }

  const rows = db.prepare('SELECT * FROM directory_chats').all();
  const settings = getSettings();
  const countRows = db.prepare('SELECT jid, COUNT(*) as total FROM messages GROUP BY jid').all();
  const countsByJid = new Map();
  for (const cr of countRows) {
    countsByJid.set(cr.jid, cr.total);
  }

  const mapped = [];
  for (const r of rows) {
    const labels = parseLabelsJson(r.labels_json);
    const tagDetails = matchChatTagDetails(r.name, labels, settings.allowedTags);
    const isAuthorized = r.explicitly_allowed === 1 || tagDetails.matched;

    // Oculta IDs @lid técnicos sem nome salvo e sem permissão/etiqueta até que a agenda os identifique
    if (
      !r.is_group &&
      r.jid.endsWith('@lid') &&
      isBareIdName(r.name, r.jid) &&
      !isAuthorized &&
      labels.length === 0
    ) {
      continue;
    }

    const msgCount = countsByJid.get(r.jid) || 0;
    let displayName = r.name;
    if (!r.is_group && isBareIdName(r.name, r.jid)) {
      displayName = r.jid.endsWith('@lid')
        ? `Contato sem nome salvo (${r.jid.split('@')[0].slice(-6)})`
        : formatPhoneDisplay(r.jid.split('@')[0]);
    }

    mapped.push({
      jid: r.jid,
      name: displayName,
      isGroup: r.is_group === 1,
      explicitlyAllowed: r.explicitly_allowed === 1,
      matchedByTag: tagDetails.matched,
      matchedByLabel: tagDetails.byLabel,
      matchedLabelName: tagDetails.matchedLabel,
      labels,
      nameSource: r.name_source || 'unknown',
      isAuthorized,
      hasHistoryCursor: Boolean(r.latest_msg_id) || msgCount > 0,
      storedMessagesCount: msgCount,
      lastSeen: r.last_seen
    });
  }

  // Ordena todas as conversas liberadas primeiro usando Collator pré-compilado (80x mais rápido que localeCompare)
  mapped.sort((a, b) => {
    if (a.isAuthorized !== b.isAuthorized) {
      return a.isAuthorized ? -1 : 1;
    }
    return PT_COLLATOR.compare(a.name, b.name);
  });

  directoryChatsCache = mapped;
  return mapped;
}

/**
 * O PORTEIRO (Filtro na Ingestão):
 * Só grava no SQLite se o chat for autorizado! Caso contrário, descarta na memória.
 */
export function ingestFilteredMessage({
  id,
  jid,
  chatName,
  senderName,
  fromMe,
  content,
  timestamp,
  nameSource = 'push'
}) {
  if (!content || !jid) return { stored: false, reason: 'vazio' };
  const canonicalJid = resolveCanonicalJid(jid);
  const isGroup = canonicalJid.endsWith('@g.us');
  if (chatName) {
    upsertDirectoryChat(canonicalJid, chatName, isGroup, {
      nameSource: isGroup ? 'contact' : nameSource
    });
  }

  const auth = isChatAuthorized(canonicalJid, chatName);
  if (!auth.allowed) {
    // Descarta imediatamente na borda — NUNCA toca a tabela messages!
    return { stored: false, reason: auth.reason };
  }

  const ts = timestamp || Date.now();
  const info = db.prepare(`
    INSERT INTO messages (id, jid, chat_name, sender_name, from_me, content, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    id || `${canonicalJid}_${ts}_${Math.random().toString(36).slice(2, 7)}`,
    canonicalJid,
    auth.name || chatName || canonicalJid,
    senderName || (fromMe ? 'Eu' : auth.name || 'Contato'),
    fromMe ? 1 : 0,
    content,
    ts
  );
  if (info.changes > 0) {
    directoryChatsCache = null;
  }

  return { stored: true, reason: auth.reason };
}

export function getAuthorizedMessages(jid, limit = 50) {
  const canonicalJid = resolveCanonicalJid(jid);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = db.prepare(`
    SELECT id, jid, chat_name, sender_name, from_me, content, timestamp
    FROM messages
    WHERE jid = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(canonicalJid, safeLimit);
  return rows.reverse();
}

export function getRecentAuthorizedMessages(limit = 40) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 150);
  const rows = db.prepare(`
    SELECT id, jid, chat_name, sender_name, from_me, content, timestamp
    FROM messages
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(safeLimit);
  return rows.reverse();
}

export function searchAuthorizedMessages(query, jid = null, limit = 30) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const likeTerm = `%${query || ''}%`;
  if (jid) {
    const canonicalJid = resolveCanonicalJid(jid);
    return db.prepare(`
      SELECT id, jid, chat_name, sender_name, from_me, content, timestamp
      FROM messages
      WHERE jid = ? AND (content LIKE ? OR sender_name LIKE ? OR chat_name LIKE ?)
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(canonicalJid, likeTerm, likeTerm, likeTerm, safeLimit).reverse();
  }
  return db.prepare(`
    SELECT id, jid, chat_name, sender_name, from_me, content, timestamp
    FROM messages
    WHERE content LIKE ? OR sender_name LIKE ? OR chat_name LIKE ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(likeTerm, likeTerm, likeTerm, safeLimit).reverse();
}

/**
 * Ferramentas de Privacidade para o Funcionário apagar mensagens do banco da IA
 */
export function deleteMessageFromAI(messageId) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
  directoryChatsCache = null;
}

export function clearChatHistoryFromAI(jid, lastHoursOnly = null) {
  const canonicalJid = resolveCanonicalJid(jid);
  if (lastHoursOnly && Number(lastHoursOnly) > 0) {
    const cutoff = Date.now() - Number(lastHoursOnly) * 3600 * 1000;
    const info = db
      .prepare('DELETE FROM messages WHERE jid = ? AND timestamp >= ?')
      .run(canonicalJid, cutoff);
    directoryChatsCache = null;
    return info.changes;
  }
  const info = db.prepare('DELETE FROM messages WHERE jid = ?').run(canonicalJid);
  directoryChatsCache = null;
  return info.changes;
}

/**
 * Auditoria em Tempo Real (Mostra para o funcionário tudo o que a IA consultou ou tentou fazer)
 */
export function addAuditLog({ actor = 'IA (MCP)', action, target, details, blocked = false }) {
  db.prepare(`
    INSERT INTO audit_logs (timestamp, actor, action, target, details, blocked)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Date.now(), actor, action, target || '-', details || '', blocked ? 1 : 0);
}

export function getAuditLogs(limit = 60) {
  return db.prepare(`
    SELECT id, timestamp, actor, action, target, details, blocked
    FROM audit_logs
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Fila de Envio & Anti-Banimento
 */
export function getSentMessagesLastHour() {
  const oneHourAgo = Date.now() - 3600 * 1000;
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM outbox_queue
    WHERE status IN ('sent', 'sending_typing', 'queued') AND created_at >= ?
  `).get(oneHourAgo);
  return row?.count || 0;
}

export function getRecentOutboxItems(limit = 30) {
  return db.prepare(`
    SELECT * FROM outbox_queue
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

export function enqueueOutboxMessage({ jid, chatName, isGroup, content, status, reason = '' }) {
  const canonicalJid = resolveCanonicalJid(jid);
  const result = db.prepare(`
    INSERT INTO outbox_queue (jid, chat_name, is_group, content, status, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(canonicalJid, chatName, isGroup ? 1 : 0, content, status, reason, Date.now());
  return Number(result.lastInsertRowid);
}

export function updateOutboxItem(id, fields) {
  const current = db.prepare('SELECT * FROM outbox_queue WHERE id = ?').get(id);
  if (!current) return null;
  const nextStatus = fields.status ?? current.status;
  const nextContent = fields.content ?? current.content;
  const nextReason = fields.reason ?? current.reason;
  const nextSentAt = fields.sent_at ?? current.sent_at;
  db.prepare(`
    UPDATE outbox_queue
    SET status = ?, content = ?, reason = ?, sent_at = ?
    WHERE id = ?
  `).run(nextStatus, nextContent, nextReason, nextSentAt, id);
  return db.prepare('SELECT * FROM outbox_queue WHERE id = ?').get(id);
}

export function getNextQueuedOutboxItem() {
  return db.prepare(`
    SELECT * FROM outbox_queue
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
  `).get();
}

export function getOutboxStats() {
  const pendingApproval =
    db.prepare("SELECT COUNT(*) as c FROM outbox_queue WHERE status = 'pending_approval'").get()?.c || 0;
  const pendingContactApprovals =
    db.prepare("SELECT COUNT(*) as c FROM contact_save_queue WHERE status = 'pending_approval'").get()?.c || 0;
  const queued =
    db.prepare("SELECT COUNT(*) as c FROM outbox_queue WHERE status IN ('queued', 'sending_typing')").get()?.c || 0;
  const sentLastHour = getSentMessagesLastHour();
  return {
    pendingApproval,
    pendingContactApprovals,
    totalPendingApprovals: pendingApproval + pendingContactApprovals,
    queued,
    sentLastHour
  };
}

/**
 * Catálogo persistente das Etiquetas / Listas personalizadas do WhatsApp
 */
const SYSTEM_PSEUDO_LABELS = new Set(['UNREAD', 'GROUPS', 'FAVORITES']);

export function saveWhatsAppLabelsCatalog(labelMapOrArray) {
  const entries =
    labelMapOrArray instanceof Map
      ? Array.from(labelMapOrArray.entries()).map(([id, name]) => ({ id: String(id), name: String(name) }))
      : Array.isArray(labelMapOrArray)
      ? labelMapOrArray
      : [];

  runInTransaction(() => {
    db.prepare('DELETE FROM whatsapp_labels').run();
    const ins = db.prepare('INSERT INTO whatsapp_labels (id, name) VALUES (?, ?)');
    for (const item of entries) {
      const cleanId = String(item?.id ?? '').trim();
      const cleanName = String(item?.name ?? '').trim();
      if (cleanId && cleanName) {
        ins.run(cleanId, cleanName);
      }
    }
  });
}

export function getWhatsAppLabelsCatalog() {
  const rows = db.prepare('SELECT id, name FROM whatsapp_labels ORDER BY CAST(id AS INTEGER), id').all();
  return rows
    .filter((r) => !SYSTEM_PSEUDO_LABELS.has(String(r.name || '').toUpperCase()))
    .map((r) => ({ id: String(r.id), name: String(r.name) }));
}

/**
 * Normalização, Trava Anti-Escalação e Fila de Salvamento de Contatos via MCP
 */
export function normalizePhoneOrContactJid(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) {
    return resolveCanonicalJid(normalizeChatJid(raw));
  }
  const digits = raw.replace(/\D/g, '');
  if (!digits || digits.length < 8 || digits.length > 18) return '';
  if (!raw.startsWith('+') && (digits.length === 10 || digits.length === 11)) {
    const brCandidate = `55${digits}@s.whatsapp.net`;
    const existsBr = db.prepare('SELECT jid FROM directory_chats WHERE jid = ?').get(brCandidate);
    if (existsBr) return brCandidate;
    return brCandidate;
  }
  return resolveCanonicalJid(`${digits}@s.whatsapp.net`);
}

export function extractFirstNameFromFullName(fullName, explicitFirstName = '') {
  const cleanExplicit = String(explicitFirstName || '').trim();
  if (cleanExplicit) return cleanExplicit.slice(0, 60);
  const stripped = String(fullName || '')
    .replace(/\[.*?\]|\(.*?\)|#\S+/g, ' ')
    .trim();
  const firstWord = stripped.split(/[\s\-–—|/]+/).filter(Boolean)[0];
  return (firstWord || String(fullName || '').trim().split(/\s+/)[0] || '').slice(0, 60);
}

export function getChatDetailsForContactSave(jid) {
  const canonicalJid = resolveCanonicalJid(jid);
  if (!canonicalJid) return null;
  const row = db.prepare('SELECT * FROM directory_chats WHERE jid = ?').get(canonicalJid);
  if (!row) return null;
  return {
    jid: row.jid,
    name: row.name,
    isGroup: row.is_group === 1,
    explicitlyAllowed: row.explicitly_allowed === 1,
    nameSource: row.name_source || 'unknown',
    lidJid: row.lid_jid || null,
    labels: parseLabelsJson(row.labels_json)
  };
}

export function validateContactSavePermission({ phoneOrJid, fullName, firstName = '', labels = [] }) {
  const canonicalJid = normalizePhoneOrContactJid(phoneOrJid);
  if (!canonicalJid) {
    return {
      allowed: false,
      blockedSecurity: false,
      error: 'Número de telefone ou JID inválido. Informe o JID completo ou o número com DDI (ex: +5511999990000).'
    };
  }

  if (
    canonicalJid.endsWith('@g.us') ||
    canonicalJid.endsWith('@broadcast') ||
    canonicalJid.endsWith('@newsletter') ||
    canonicalJid === 'status@broadcast'
  ) {
    return {
      allowed: false,
      blockedSecurity: false,
      canonicalJid,
      error: 'Não é possível salvar um grupo ou lista de transmissão como contato individual na agenda.'
    };
  }

  const cleanFullName = String(fullName || '').replace(/\s+/g, ' ').trim();
  if (cleanFullName.length < 2 || cleanFullName.length > 120) {
    return {
      allowed: false,
      blockedSecurity: false,
      canonicalJid,
      error: 'O nome completo do contato deve ter entre 2 e 120 caracteres.'
    };
  }

  const cleanFirstName = extractFirstNameFromFullName(cleanFullName, firstName);
  const cleanLabels = Array.from(
    new Set((Array.isArray(labels) ? labels : []).map((l) => String(l || '').trim()).filter(Boolean))
  );

  const row = db.prepare('SELECT * FROM directory_chats WHERE jid = ?').get(canonicalJid);
  if (row?.is_group === 1) {
    return {
      allowed: false,
      blockedSecurity: false,
      canonicalJid,
      error: 'Este JID pertence a um grupo do WhatsApp, não a um contato individual.'
    };
  }

  const existingLabels = parseLabelsJson(row?.labels_json);
  const currentAuth = isChatAuthorized(canonicalJid);
  const isExistingSavedContact = Boolean(
    row && row.name_source === 'contact' && !isBareIdName(row.name, canonicalJid)
  );

  if (!currentAuth.allowed) {
    // TRAVA INVIOLÁVEL: Jamais renomear ou etiquetar um contato pessoal já salvo na agenda!
    if (isExistingSavedContact) {
      return {
        allowed: false,
        blockedSecurity: true,
        canonicalJid,
        previousName: row.name,
        error:
          'Bloqueio de Privacidade: Este número já pertence a um contato pessoal salvo na sua agenda que não está liberado para a IA. A IA nunca pode renomear ou etiquetar contatos privados existentes.'
      };
    }

    const mergedLabels = Array.from(new Set([...existingLabels, ...cleanLabels]));
    const proposedTagMatch = matchChatTagDetails(cleanFullName, mergedLabels);
    if (!proposedTagMatch.matched) {
      const allowedList = (getSettings().allowedTags || []).join(', ') || '[EMP]';
      return {
        allowed: false,
        blockedSecurity: true,
        canonicalJid,
        error: `Bloqueio de Escopo Comercial: Para salvar um número novo ainda não liberado, inclua uma tag de trabalho autorizada no nome ou nas etiquetas (ex: ${allowedList}).`
      };
    }
  }

  const displayPhone = canonicalJid.endsWith('@lid')
    ? `ID ${canonicalJid.split('@')[0].slice(-6)}`
    : formatPhoneDisplay(canonicalJid.split('@')[0]);

  const previousName =
    row && !isBareIdName(row.name, canonicalJid) ? row.name : displayPhone;

  return {
    allowed: true,
    blockedSecurity: false,
    canonicalJid,
    lidJid: row?.lid_jid || (canonicalJid.endsWith('@lid') ? canonicalJid : null),
    displayPhone,
    previousName,
    wasAlreadySaved: isExistingSavedContact,
    fullName: cleanFullName,
    firstName: cleanFirstName,
    labels: cleanLabels,
    existingLabels
  };
}

function hydrateContactSaveRow(r) {
  if (!r) return null;
  const displayPhone = r.jid.endsWith('@lid')
    ? `ID ${r.jid.split('@')[0].slice(-6)}`
    : formatPhoneDisplay(r.jid.split('@')[0]);
  return {
    ...r,
    displayPhone,
    labels: parseLabelsJson(r.labels_json)
  };
}

export function enqueueContactSave({
  jid,
  lidJid = null,
  previousName = '',
  fullName,
  firstName,
  labels = [],
  status = 'pending_approval',
  reason = '',
  actor = 'IA (MCP)',
  appliedAt = null
}) {
  const canonicalJid = resolveCanonicalJid(jid);
  const cleanLabels = Array.from(
    new Set((labels || []).map((l) => String(l || '').trim()).filter(Boolean))
  );

  // Se já existe um pedido pendente para o mesmo JID, atualiza-o evitando cards duplicados na tela
  if (status === 'pending_approval') {
    const existingPending = db
      .prepare("SELECT id FROM contact_save_queue WHERE jid = ? AND status = 'pending_approval' LIMIT 1")
      .get(canonicalJid);
    if (existingPending?.id) {
      db.prepare(`
        UPDATE contact_save_queue
        SET lid_jid = COALESCE(?, lid_jid),
            previous_name = ?,
            full_name = ?,
            first_name = ?,
            labels_json = ?,
            reason = ?,
            actor = ?,
            created_at = ?
        WHERE id = ?
      `).run(
        lidJid,
        previousName,
        fullName,
        firstName,
        JSON.stringify(cleanLabels),
        reason,
        actor,
        Date.now(),
        existingPending.id
      );
      return Number(existingPending.id);
    }
  }

  const res = db.prepare(`
    INSERT INTO contact_save_queue (
      jid, lid_jid, previous_name, full_name, first_name, labels_json,
      status, reason, actor, created_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    canonicalJid,
    lidJid,
    previousName,
    fullName,
    firstName,
    JSON.stringify(cleanLabels),
    status,
    reason,
    actor,
    Date.now(),
    appliedAt
  );
  return Number(res.lastInsertRowid);
}

export function getContactSaveItemById(id) {
  const row = db.prepare('SELECT * FROM contact_save_queue WHERE id = ?').get(Number(id));
  return hydrateContactSaveRow(row);
}

export function getPendingContactSaveItems() {
  const rows = db
    .prepare("SELECT * FROM contact_save_queue WHERE status = 'pending_approval' ORDER BY created_at ASC")
    .all();
  return rows.map(hydrateContactSaveRow);
}

export function getRecentContactSaveItems(limit = 35) {
  const rows = db
    .prepare(`
      SELECT * FROM contact_save_queue
      ORDER BY CASE WHEN status = 'pending_approval' THEN 0 ELSE 1 END, created_at DESC
      LIMIT ?
    `)
    .all(limit);
  return rows.map(hydrateContactSaveRow);
}

export function updateContactSaveItem(id, fields = {}) {
  const current = db.prepare('SELECT * FROM contact_save_queue WHERE id = ?').get(Number(id));
  if (!current) return null;
  const nextFullName =
    fields.full_name !== undefined ? String(fields.full_name).trim() : current.full_name;
  const nextFirstName =
    fields.first_name !== undefined
      ? String(fields.first_name).trim()
      : fields.full_name !== undefined
      ? extractFirstNameFromFullName(nextFullName)
      : current.first_name;
  const nextLabelsJson =
    fields.labels !== undefined ? JSON.stringify(fields.labels) : current.labels_json;
  const nextStatus = fields.status ?? current.status;
  const nextReason = fields.reason ?? current.reason;
  const nextLidJid = fields.lid_jid !== undefined ? fields.lid_jid : current.lid_jid;
  const nextAppliedAt = fields.applied_at !== undefined ? fields.applied_at : current.applied_at;

  db.prepare(`
    UPDATE contact_save_queue
    SET full_name = ?, first_name = ?, labels_json = ?, status = ?, reason = ?, lid_jid = ?, applied_at = ?
    WHERE id = ?
  `).run(
    nextFullName,
    nextFirstName,
    nextLabelsJson,
    nextStatus,
    nextReason,
    nextLidJid,
    nextAppliedAt,
    Number(id)
  );
  return getContactSaveItemById(id);
}

export function rejectAllPendingContactSaves() {
  const info = db
    .prepare(`
      UPDATE contact_save_queue
      SET status = 'rejected', reason = 'Recusado em lote pelo usuário'
      WHERE status = 'pending_approval'
    `)
    .run();
  return info.changes;
}

export const DEMO_JIDS = [
  '120363001@g.us',
  '120363002@g.us',
  '120363999@g.us',
  '5511988881111@s.whatsapp.net',
  '5511988882222@s.whatsapp.net',
  '5511977770001@s.whatsapp.net',
  '5511977770002@s.whatsapp.net'
];

export function clearDemoData() {
  const placeholders = DEMO_JIDS.map(() => '?').join(', ');
  db.prepare(`DELETE FROM directory_chats WHERE jid IN (${placeholders})`).run(...DEMO_JIDS);
  db.prepare(`DELETE FROM messages WHERE jid IN (${placeholders}) OR id LIKE 'demo_%'`).run(...DEMO_JIDS);
  db.prepare(`DELETE FROM outbox_queue WHERE jid IN (${placeholders})`).run(...DEMO_JIDS);
  db.prepare(`DELETE FROM contact_save_queue WHERE jid IN (${placeholders})`).run(...DEMO_JIDS);
  directoryChatsCache = null;
}
