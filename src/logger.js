import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOG_DATA_DIR =
  process.env.GUARDIAO_DATA_DIR ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GuardiaoWhatsApp')
    : path.join(os.homedir(), '.guardiao-whatsapp'));

if (!fs.existsSync(LOG_DATA_DIR)) {
  fs.mkdirSync(LOG_DATA_DIR, { recursive: true });
}

export const LOG_FILE_PATH = path.join(LOG_DATA_DIR, 'guardiao.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB

function writeLine(level, scope, message, meta = null) {
  try {
    if (fs.existsSync(LOG_FILE_PATH)) {
      const st = fs.statSync(LOG_FILE_PATH);
      if (st.size > MAX_LOG_BYTES) {
        const tail = fs.readFileSync(LOG_FILE_PATH, 'utf8').slice(-512 * 1024);
        fs.writeFileSync(LOG_FILE_PATH, tail, 'utf8');
      }
    }
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const metaStr =
      meta !== null && meta !== undefined
        ? ` | ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`
        : '';
    const line = `[${ts}] [${level}] [${scope}] ${message}${metaStr}\n`;
    fs.appendFileSync(LOG_FILE_PATH, line, 'utf8');
  } catch {
    // nunca interrompe o app por falha de escrita de log
  }
}

export function logInfo(scope, message, meta = null) {
  writeLine('INFO', scope, message, meta);
}

export function logWarn(scope, message, meta = null) {
  writeLine('WARN', scope, message, meta);
}

export function logError(scope, message, errOrMeta = null) {
  const formatted =
    errOrMeta instanceof Error
      ? `${errOrMeta.message} (${errOrMeta.stack?.split('\n')[1]?.trim() || ''})`
      : errOrMeta;
  writeLine('ERROR', scope, message, formatted);
}

export function readRecentLogLines(maxLines = 120) {
  try {
    if (!fs.existsSync(LOG_FILE_PATH)) return [];
    const content = fs.readFileSync(LOG_FILE_PATH, 'utf8');
    const lines = content.trim().split(/\r?\n/);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function installProcessLogHooks(processName = 'server') {
  process.on('uncaughtException', (err) => {
    logError(processName, 'UncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    logError(processName, 'UnhandledRejection', reason instanceof Error ? reason : String(reason));
  });
}
