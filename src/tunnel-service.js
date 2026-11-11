import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { DATA_DIR, getSettings, updateSettings } from './db.js';
import { logError, logInfo } from './logger.js';

const BIN_DIR = path.join(DATA_DIR, 'bin');
const CLOUDFLARED_EXE = path.join(
  BIN_DIR,
  process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
);

const CLOUDFLARED_WIN_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

class TunnelService {
  constructor() {
    this.proc = null;
    this.status = 'stopped'; // 'stopped' | 'downloading' | 'starting' | 'running' | 'error'
    this.publicBaseUrl = '';
    this.lastError = '';
    this.mode = 'quick'; // 'quick' | 'custom'

    process.on('exit', () => {
      this._killProcess();
    });
  }

  _findCloudflaredBinary() {
    if (fs.existsSync(CLOUDFLARED_EXE)) {
      return CLOUDFLARED_EXE;
    }
    try {
      const cmd = process.platform === 'win32' ? 'where cloudflared' : 'which cloudflared';
      const found = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (found && fs.existsSync(found)) {
        return found;
      }
    } catch {
      // não instalado globalmente
    }
    return null;
  }

  async _ensureCloudflaredBinary() {
    const existing = this._findCloudflaredBinary();
    if (existing) return existing;

    if (process.platform !== 'win32') {
      throw new Error(
        'Instale o utilitário "cloudflared" no sistema para abrir o túnel HTTPS automático.'
      );
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    this.status = 'downloading';
    logInfo('tunnel', 'Baixando binário oficial cloudflared pela primeira vez...');

    const response = await fetch(CLOUDFLARED_WIN_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(90000)
    });

    if (!response.ok) {
      throw new Error(`Falha ao baixar conector Cloudflare (HTTP ${response.status}).`);
    }

    const arrayBuf = await response.arrayBuffer();
    const tmpFile = `${CLOUDFLARED_EXE}.tmp`;
    fs.writeFileSync(tmpFile, Buffer.from(arrayBuf));
    fs.renameSync(tmpFile, CLOUDFLARED_EXE);

    logInfo('tunnel', 'cloudflared salvo com sucesso', { path: CLOUDFLARED_EXE });
    return CLOUDFLARED_EXE;
  }

  getStatus(localPort = 3847) {
    const settings = getSettings();
    const token = settings.mcpHttpToken;
    const localMcpUrl = `http://127.0.0.1:${localPort}/mcp?token=${token}`;
    const publicMcpUrl = this.publicBaseUrl
      ? `${this.publicBaseUrl.replace(/\/+$/, '')}/mcp?token=${token}`
      : '';

    return {
      status: this.status,
      enabled: Boolean(settings.webTunnelEnabled),
      mode: this.mode,
      publicBaseUrl: this.publicBaseUrl,
      publicMcpUrl,
      localMcpUrl,
      token,
      customTunnelUrl: settings.customTunnelUrl || '',
      hasCustomToken: Boolean(settings.customTunnelToken),
      lastError: this.lastError
    };
  }

  async start(localPort = 3847) {
    if (this.status === 'running' || this.status === 'starting' || this.status === 'downloading') {
      return this.getStatus(localPort);
    }

    this._killProcess();
    this.lastError = '';
    const settings = getSettings();
    const customToken = String(settings.customTunnelToken || '').trim();
    const customUrl = String(settings.customTunnelUrl || '').trim().replace(/\/+$/, '');

    try {
      const binPath = await this._ensureCloudflaredBinary();
      this.status = 'starting';

      if (customToken && customUrl) {
        this.mode = 'custom';
        logInfo('tunnel', 'Iniciando túnel fixo Cloudflare...');
        this.proc = spawn(binPath, ['tunnel', '--no-autoupdate', 'run', '--token', customToken], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        this.publicBaseUrl = customUrl.startsWith('http') ? customUrl : `https://${customUrl}`;
        this.status = 'running';
        updateSettings({ webTunnelEnabled: true });
        this._attachExitHandlers();
        return this.getStatus(localPort);
      }

      this.mode = 'quick';
      logInfo('tunnel', 'Iniciando Quick Tunnel HTTPS Cloudflare...');

      await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Tempo esgotado aguardando URL HTTPS da Cloudflare.'));
          }
        }, 25000);

        const proc = spawn(
          binPath,
          ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate'],
          {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          }
        );
        this.proc = proc;

        const onChunk = (chunk) => {
          const text = chunk.toString('utf8');
          const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
          if (match && !settled) {
            settled = true;
            clearTimeout(timeout);
            this.publicBaseUrl = match[0];
            this.status = 'running';
            logInfo('tunnel', 'Quick Tunnel HTTPS ativo', { url: this.publicBaseUrl });
            resolve();
          }
        };

        proc.stdout?.on('data', onChunk);
        proc.stderr?.on('data', onChunk);

        proc.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(err);
          }
        });

        proc.on('exit', (code) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`Processo cloudflared encerrou prematuramente (código ${code}).`));
          } else if (this.proc === proc) {
            this.proc = null;
            this.status = 'stopped';
            this.publicBaseUrl = '';
          }
        });
      });

      this._attachExitHandlers();
      updateSettings({ webTunnelEnabled: true });
      return this.getStatus(localPort);
    } catch (err) {
      this._killProcess();
      this.status = 'error';
      this.lastError = err?.message || 'Erro ao iniciar túnel HTTPS.';
      logError('tunnel', 'Falha ao iniciar túnel HTTPS', err);
      return this.getStatus(localPort);
    }
  }

  _attachExitHandlers() {
    const proc = this.proc;
    if (!proc) return;
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null;
        this.status = 'stopped';
        this.publicBaseUrl = '';
      }
    });
  }

  stop(persistSetting = true, localPort = 3847) {
    this._killProcess();
    this.status = 'stopped';
    this.publicBaseUrl = '';
    this.lastError = '';
    if (persistSetting) {
      updateSettings({ webTunnelEnabled: false });
    }
    logInfo('tunnel', 'Túnel HTTPS encerrado');
    return this.getStatus(localPort);
  }

  _killProcess() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignora
      }
      this.proc = null;
    }
  }
}

export const tunnelService = new TunnelService();
