import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_KEY = 'whatsapp-guard';
const BRIDGE_SCRIPT_PATH = path.resolve(__dirname, 'mcp-bridge.js');
const BIN_DIR = path.join(DATA_DIR, 'bin');

// Rastreia quais clientes acabaram de ser ativados nesta sessão para sugerir reinício se aplicável
const recentlyInstalledAt = new Map();

function ensureFallbackLauncher() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (process.platform === 'win32') {
    const cmdPath = path.join(BIN_DIR, 'guardiao-mcp.cmd');
    const exePath = process.execPath;
    const content = [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      'if "%WHATSAPP_GUARD_URL%"=="" set WHATSAPP_GUARD_URL=http://127.0.0.1:3847',
      `"${exePath}" "${BRIDGE_SCRIPT_PATH}" %*`
    ].join('\r\n');
    writeFileAtomic(cmdPath, content);
    return {
      command: exePath,
      args: [BRIDGE_SCRIPT_PATH],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        WHATSAPP_GUARD_URL: 'http://127.0.0.1:3847'
      }
    };
  }

  const shPath = path.join(BIN_DIR, 'guardiao-mcp.sh');
  const shContent = [
    '#!/usr/bin/env sh',
    'export ELECTRON_RUN_AS_NODE=1',
    'export WHATSAPP_GUARD_URL="${WHATSAPP_GUARD_URL:-http://127.0.0.1:3847}"',
    `exec "${process.execPath}" "${BRIDGE_SCRIPT_PATH}" "$@"`
  ].join('\n');
  writeFileAtomic(shPath, shContent);
  try {
    fs.chmodSync(shPath, 0o755);
  } catch {
    // ignora
  }
  return {
    command: shPath,
    args: [],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      WHATSAPP_GUARD_URL: 'http://127.0.0.1:3847'
    }
  };
}

/**
 * Descobre o comando ideal para rodar o mcp-bridge.js:
 * - Se Node.js estiver instalado no PC, usa node.exe direto (zero overhead).
 * - Se o funcionário NÃO tiver Node.js instalado, gera e usa o launcher embutido do Guardião
 *   via cmd.exe /c guardiao-mcp.cmd (evitando erro spawn EINVAL em Node 20+ e garantindo ELECTRON_RUN_AS_NODE=1).
 */
export function resolveBridgeCommand(options = {}) {
  if (!options.forceFallback) {
    try {
      const cmd = process.platform === 'win32' ? 'where node' : 'which node';
      const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (out && fs.existsSync(out)) {
        return {
          command: out,
          args: [BRIDGE_SCRIPT_PATH],
          env: { WHATSAPP_GUARD_URL: 'http://127.0.0.1:3847' },
          mode: 'node'
        };
      }
    } catch {
      // fallback abaixo
    }
  }

  return {
    ...ensureFallbackLauncher(),
    mode: 'embedded-electron'
  };
}

function resolveClaudeFiles(home, appData, localAppData) {
  if (process.platform === 'darwin') {
    const macDesktop = path.join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
    const list = [{ path: macDesktop, format: 'json-mcpServers' }];
    const dotClaude = path.join(home, '.claude.json');
    if (fs.existsSync(dotClaude)) {
      list.push({ path: dotClaude, format: 'json-mcpServers' });
    }
    return list;
  }

  const found = [];

  // 1. Microsoft Store / MSIX v4+ (%LOCALAPPDATA%\Claude-Data\claude_*)
  const claudeDataRoot = path.join(localAppData, 'Claude-Data');
  let hasClaudeDataDir = false;
  if (fs.existsSync(claudeDataRoot)) {
    try {
      for (const entry of fs.readdirSync(claudeDataRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith('claude_')) {
          hasClaudeDataDir = true;
          found.push(path.join(claudeDataRoot, entry.name, 'claude_desktop_config.json'));
        }
      }
    } catch {
      // ignora
    }
  }

  // 2. Microsoft Store / MSIX legado (Packages\Claude_*\LocalCache\Roaming\Claude)
  const packagesRoot = path.join(localAppData, 'Packages');
  if (fs.existsSync(packagesRoot)) {
    try {
      for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith('claude_')) {
          const msixDir = path.join(packagesRoot, entry.name, 'LocalCache', 'Roaming', 'Claude');
          const msixCfg = path.join(msixDir, 'claude_desktop_config.json');
          if (fs.existsSync(msixCfg) || (!hasClaudeDataDir && fs.existsSync(msixDir))) {
            found.push(msixCfg);
          }
        }
      }
    } catch {
      // ignora
    }
  }

  // 3. Instalador tradicional (%APPDATA%\Claude\claude_desktop_config.json)
  const classicDir = path.join(appData, 'Claude');
  const classicCfg = path.join(classicDir, 'claude_desktop_config.json');
  if (fs.existsSync(classicDir) || found.length === 0) {
    found.push(classicCfg);
  }

  // 4. Claude Code CLI / Aba Code do Claude Desktop (~/.claude.json)
  const dotClaude = path.join(home, '.claude.json');
  if (fs.existsSync(dotClaude)) {
    found.push(dotClaude);
  }

  return [...new Set(found)].map((p) => ({ path: p, format: 'json-mcpServers' }));
}

function resolveCodexFiles(home, localAppData) {
  const files = [{ path: path.join(home, '.codex', 'config.toml'), format: 'toml-mcp-servers' }];
  if (process.platform === 'win32') {
    const packagesRoot = path.join(localAppData, 'Packages');
    if (fs.existsSync(packagesRoot)) {
      try {
        for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.toLowerCase().startsWith('openai.codex')) {
            const msixToml = path.join(
              packagesRoot,
              entry.name,
              'LocalCache',
              'Roaming',
              'Codex',
              'config.toml'
            );
            if (fs.existsSync(msixToml)) {
              files.push({ path: msixToml, format: 'toml-mcp-servers' });
            }
          }
        }
      } catch {
        // ignora
      }
    }
  }
  return files;
}

function resolveVsCodeFiles(home, appData) {
  const vscodeUserDir =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
      : path.join(appData, 'Code', 'User');

  const files = [{ path: path.join(vscodeUserDir, 'mcp.json'), format: 'json-vscode-servers' }];

  const copilotDir = path.join(home, '.copilot');
  if (fs.existsSync(copilotDir)) {
    files.push({ path: path.join(copilotDir, 'mcp-config.json'), format: 'json-mcpServers' });
  }
  return files;
}

function hasAnyExistingPath(paths) {
  return paths.some((p) => fs.existsSync(p));
}

function hasCommandOnSystem(cmdName) {
  try {
    const check = process.platform === 'win32' ? `where ${cmdName}` : `which ${cmdName}`;
    const out = execSync(check, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

export function getClientTargets(customBaseDirs = null) {
  const home = customBaseDirs?.home || os.homedir();
  const appData =
    customBaseDirs?.appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData =
    customBaseDirs?.localAppData ||
    process.env.LOCALAPPDATA ||
    path.join(home, 'AppData', 'Local');

  const antigravityV2Path = path.join(home, '.gemini', 'config', 'mcp_config.json');
  const antigravityLegacyPath = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
  const claudeFiles = resolveClaudeFiles(home, appData, localAppData);
  const geminiSettingsPath = path.join(home, '.gemini', 'settings.json');
  const grokCliTomlPath = path.join(home, '.grok', 'config.toml');
  const codexFiles = resolveCodexFiles(home, localAppData);
  const cursorPath = path.join(home, '.cursor', 'mcp.json');
  const vscodeFiles = resolveVsCodeFiles(home, appData);
  const windsurfPath = path.join(home, '.codeium', 'windsurf', 'mcp_config.json');

  // Detecta pacotes MSIX para Codex e Claude mesmo que a pasta oculta nunca tenha sido aberta
  let hasCodexMsix = false;
  let hasClaudeMsix = false;
  const packagesRoot = path.join(localAppData, 'Packages');
  if (fs.existsSync(packagesRoot)) {
    try {
      for (const e of fs.readdirSync(packagesRoot)) {
        const lower = e.toLowerCase();
        if (lower.startsWith('openai.codex')) hasCodexMsix = true;
        if (lower.startsWith('claude_')) hasClaudeMsix = true;
      }
    } catch {
      // ignora
    }
  }

  return [
    {
      id: 'antigravity',
      badge: 'AN',
      name: 'Antigravity',
      description: 'Google Antigravity IDE / Agent',
      reloadHint: 'No Antigravity, abra (...) → MCP Servers → Refresh (ou nova conversa)',
      canRestart: false,
      processNames: [],
      appSearchPattern: '',
      detectPaths: [
        path.join(home, '.gemini', 'config'),
        path.join(home, '.gemini', 'antigravity'),
        path.join(home, '.gemini', 'antigravity-ide')
      ],
      files: [
        { path: antigravityV2Path, format: 'json-mcpServers' },
        { path: antigravityLegacyPath, format: 'json-mcpServers' }
      ]
    },
    {
      id: 'claude',
      badge: 'CL',
      name: 'Claude (Desktop & Code)',
      description: 'Microsoft Store, Instalador Desktop e Claude Code',
      reloadHint: 'Se o Claude já estava aberto, clique em Reiniciar app para carregar',
      canRestart: true,
      processNames: ['Claude.exe', 'claude.exe'],
      appSearchPattern: '^Claude$',
      extraDetected: hasClaudeMsix,
      detectPaths: [
        path.join(localAppData, 'Claude-Data'),
        path.join(appData, 'Claude'),
        path.join(home, '.claude.json')
      ],
      files: claudeFiles
    },
    {
      id: 'gemini',
      badge: 'GE',
      name: 'Google Gemini (CLI & Code Assist)',
      description: 'Gemini CLI e extensões locais (.gemini/settings.json)',
      reloadHint: 'Abra uma nova janela/sessão do Gemini CLI para carregar',
      canRestart: false,
      processNames: [],
      appSearchPattern: '',
      detectPaths: [path.join(home, '.gemini'), path.join(appData, 'gemini')],
      files: [{ path: geminiSettingsPath, format: 'json-mcpServers' }]
    },
    {
      id: 'codex',
      badge: 'CX',
      name: 'Codex (OpenAI)',
      description: 'Aplicativo Desktop OpenAI (Store) e Codex CLI',
      reloadHint: 'Se o Codex já estava aberto, reinicie o aplicativo',
      canRestart: true,
      processNames: ['Codex.exe'],
      appSearchPattern: 'Codex',
      extraDetected: hasCodexMsix,
      detectPaths: [path.join(home, '.codex'), path.join(localAppData, 'OpenAI', 'Codex')],
      files: codexFiles
    },
    {
      id: 'cursor',
      badge: 'CU',
      name: 'Cursor',
      description: 'Editor de código e agente Cursor',
      reloadHint: 'Se o Cursor já estava aberto, recarregue ou reinicie o editor',
      canRestart: true,
      processNames: ['Cursor.exe'],
      appSearchPattern: '^Cursor$',
      detectPaths: [
        path.join(home, '.cursor'),
        path.join(localAppData, 'Programs', 'cursor')
      ],
      files: [{ path: cursorPath, format: 'json-mcpServers' }]
    },
    {
      id: 'vscode',
      badge: 'VS',
      name: 'VS Code & GitHub Copilot',
      description: 'Visual Studio Code (Agent Mode) e Copilot CLI',
      reloadHint: 'No VS Code, recarregue a janela ou reinicie o editor',
      canRestart: true,
      processNames: ['Code.exe'],
      appSearchPattern: 'Visual Studio Code',
      detectPaths: [
        path.dirname(vscodeFiles[0].path),
        path.join(home, '.copilot'),
        path.join(localAppData, 'Programs', 'Microsoft VS Code')
      ],
      files: vscodeFiles
    },
    {
      id: 'grok-cli',
      badge: 'GK',
      name: 'Grok CLI / Grok Build (xAI)',
      description: 'Agente local de terminal da xAI (~/.grok/config.toml)',
      reloadHint: 'Inicie uma nova sessão do comando grok no terminal',
      canRestart: false,
      processNames: [],
      appSearchPattern: '',
      extraDetected: customBaseDirs ? false : hasCommandOnSystem('grok'),
      detectPaths: [path.join(home, '.grok')],
      files: [{ path: grokCliTomlPath, format: 'toml-mcp-servers' }]
    },
    {
      id: 'windsurf',
      badge: 'WS',
      name: 'Windsurf',
      description: 'Editor e agente Windsurf (Codeium)',
      reloadHint: 'Recarregue a janela do Windsurf após ativar',
      canRestart: true,
      processNames: ['Windsurf.exe'],
      appSearchPattern: 'Windsurf',
      detectPaths: [
        path.join(home, '.codeium', 'windsurf'),
        path.join(localAppData, 'Programs', 'Windsurf')
      ],
      files: [{ path: windsurfPath, format: 'json-mcpServers' }]
    }
  ];
}

function isFileConfigured(fileEntry) {
  const { path: filePath, format } = fileEntry;
  if (!fs.existsSync(filePath)) return false;

  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return false;

    if (format === 'json-mcpServers') {
      const parsed = JSON.parse(raw);
      return Boolean(parsed?.mcpServers?.[SERVER_KEY]);
    }

    if (format === 'json-vscode-servers') {
      const parsed = JSON.parse(raw);
      return Boolean(parsed?.servers?.[SERVER_KEY]);
    }

    if (format === 'toml-mcp-servers') {
      const hasSection =
        raw.includes(`[mcp_servers.${SERVER_KEY}]`) ||
        raw.includes(`[mcpServers.${SERVER_KEY}]`);
      if (!hasSection) return false;
      const sectionSlice = extractTomlSectionText(raw, SERVER_KEY);
      if (/\benabled\s*=\s*false\b/i.test(sectionSlice)) return false;
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function extractTomlSectionText(tomlContent, key) {
  const lines = tomlContent.split(/\r?\n/);
  let inside = false;
  const collected = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === `[mcp_servers.${key}]` || trimmed === `[mcpServers.${key}]`) {
      inside = true;
      continue;
    }
    if (inside && trimmed.startsWith('[')) {
      break;
    }
    if (inside) {
      collected.push(trimmed);
    }
  }
  return collected.join('\n');
}

function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.guardiao.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignora
    }
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

export function getAIClientsStatus(customBaseDirs = null) {
  const targets = getClientTargets(customBaseDirs);
  return targets.map((t) => {
    const configured = t.files.length > 0 && t.files.every((f) => isFileConfigured(f));
    const detected =
      Boolean(t.extraDetected) ||
      configured ||
      hasAnyExistingPath(t.detectPaths) ||
      t.files.some((f) => fs.existsSync(f.path));

    return {
      id: t.id,
      badge: t.badge,
      name: t.name,
      description: t.description,
      reloadHint: t.reloadHint,
      canRestart: t.canRestart,
      recentlyActivated: recentlyInstalledAt.has(t.id),
      configPath: t.files[0]?.path || '',
      configPaths: t.files.map((f) => f.path),
      detected,
      configured
    };
  });
}

function writeMcpIntoFile(fileEntry, bridge) {
  const { path: cfgPath, format } = fileEntry;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

  if (format === 'json-mcpServers' || format === 'json-vscode-servers') {
    const rootKey = format === 'json-vscode-servers' ? 'servers' : 'mcpServers';
    let data = {};
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
        if (raw.trim()) data = JSON.parse(raw);
      } catch {
        fs.copyFileSync(cfgPath, `${cfgPath}.guardiao.bak`);
        data = {};
      }
    }

    if (!data[rootKey] || typeof data[rootKey] !== 'object' || Array.isArray(data[rootKey])) {
      data[rootKey] = {};
    }

    const entryPayload =
      format === 'json-vscode-servers'
        ? {
            type: 'stdio',
            command: bridge.command,
            args: bridge.args,
            env: bridge.env
          }
        : {
            command: bridge.command,
            args: bridge.args,
            env: bridge.env
          };

    data[rootKey][SERVER_KEY] = entryPayload;
    writeFileAtomic(cfgPath, JSON.stringify(data, null, 2));
    return;
  }

  if (format === 'toml-mcp-servers') {
    let rawToml = '';
    if (fs.existsSync(cfgPath)) {
      rawToml = fs.readFileSync(cfgPath, 'utf8');
      rawToml = removeTomlSection(rawToml, SERVER_KEY);
    }

    const escapedCmd = bridge.command.replace(/\\/g, '\\\\');
    const escapedArgs = bridge.args
      .map((a) => `"${String(a).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(', ');
    const envLines = Object.entries(bridge.env).map(
      ([k, v]) => `${k} = "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    );

    const tomlBlock = [
      '',
      '# --- Guardião WhatsApp MCP (Auto-instalado) ---',
      `[mcp_servers.${SERVER_KEY}]`,
      'enabled = true',
      `command = "${escapedCmd}"`,
      `args = [${escapedArgs}]`,
      'startup_timeout_sec = 30',
      '',
      `[mcp_servers.${SERVER_KEY}.env]`,
      ...envLines,
      '# --- Fim Guardião WhatsApp MCP ---',
      ''
    ].join('\n');

    const prefix = rawToml.trimEnd();
    writeFileAtomic(cfgPath, prefix ? `${prefix}\n${tomlBlock}` : `${tomlBlock.trimStart()}`);
  }
}

function removeMcpFromFile(fileEntry) {
  const { path: cfgPath, format } = fileEntry;
  if (!fs.existsSync(cfgPath)) return;

  if (format === 'json-mcpServers' || format === 'json-vscode-servers') {
    const rootKey = format === 'json-vscode-servers' ? 'servers' : 'mcpServers';
    try {
      const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      if (data?.[rootKey]?.[SERVER_KEY]) {
        delete data[rootKey][SERVER_KEY];
        writeFileAtomic(cfgPath, JSON.stringify(data, null, 2));
      }
    } catch {
      // ignora se inválido
    }
    return;
  }

  if (format === 'toml-mcp-servers') {
    const rawToml = fs.readFileSync(cfgPath, 'utf8');
    const cleaned = removeTomlSection(rawToml, SERVER_KEY);
    writeFileAtomic(cfgPath, cleaned);
  }
}

export function installMCPInClient(clientId, customBaseDirs = null) {
  const target = getClientTargets(customBaseDirs).find((t) => t.id === clientId);
  if (!target) {
    throw new Error(`Cliente de IA desconhecido: ${clientId}`);
  }

  const bridge = resolveBridgeCommand();
  for (const fileEntry of target.files) {
    writeMcpIntoFile(fileEntry, bridge);
  }

  recentlyInstalledAt.set(clientId, Date.now());
  return {
    installed: true,
    client: target.name,
    configPath: target.files[0]?.path || '',
    configPaths: target.files.map((f) => f.path)
  };
}

export function uninstallMCPFromClient(clientId, customBaseDirs = null) {
  const target = getClientTargets(customBaseDirs).find((t) => t.id === clientId);
  if (!target) {
    return { removed: true };
  }

  for (const fileEntry of target.files) {
    removeMcpFromFile(fileEntry);
  }
  recentlyInstalledAt.delete(clientId);
  return { removed: true, client: target.name };
}

export function installMCPInAllDetected(customBaseDirs = null) {
  const statuses = getAIClientsStatus(customBaseDirs);
  const results = [];
  for (const s of statuses) {
    if (s.detected) {
      results.push(installMCPInClient(s.id, customBaseDirs));
    }
  }
  return results;
}

export function removeTomlSection(tomlContent, key) {
  const lines = tomlContent.split(/\r?\n/);
  const out = [];
  let skippingMarkerBlock = false;
  let skippingSection = false;

  const exactMain = `[mcp_servers.${key}]`;
  const exactAlt = `[mcpServers.${key}]`;
  const subPrefixMain = `[mcp_servers.${key}.`;
  const subPrefixAlt = `[mcpServers.${key}.`;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '# --- Guardião WhatsApp MCP (Auto-instalado) ---') {
      skippingMarkerBlock = true;
      continue;
    }
    if (trimmed === '# --- Fim Guardião WhatsApp MCP ---') {
      skippingMarkerBlock = false;
      skippingSection = false;
      continue;
    }
    if (skippingMarkerBlock) {
      continue;
    }

    if (
      trimmed === exactMain ||
      trimmed === exactAlt ||
      trimmed.startsWith(subPrefixMain) ||
      trimmed.startsWith(subPrefixAlt)
    ) {
      skippingSection = true;
      continue;
    }

    if (skippingSection && trimmed.startsWith('[')) {
      skippingSection = false;
    }

    if (!skippingSection) {
      out.push(line);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Executa um autoteste real do mcp-bridge.js via stdio (initialize + tools/list)
 * para garantir que o comando gravado nos clientes de IA está 100% funcional.
 */
export async function testMcpBridgeHandshake(options = {}) {
  const startedAt = Date.now();
  const bridge = resolveBridgeCommand(options);

  return new Promise((resolve) => {
    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        // ignora
      }
      resolve(payload);
    };

    const proc = spawn(bridge.command, bridge.args, {
      env: { ...process.env, ...bridge.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      finish({
        ok: false,
        latencyMs: Date.now() - startedAt,
        mode: bridge.mode,
        error: `Tempo limite excedido no autoteste MCP. ${stderrBuf.trim()}`.trim()
      });
    }, 8000);

    proc.on('error', (err) => {
      finish({
        ok: false,
        latencyMs: Date.now() - startedAt,
        mode: bridge.mode,
        error: err.message
      });
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && Array.isArray(msg?.result?.tools)) {
            finish({
              ok: true,
              latencyMs: Date.now() - startedAt,
              mode: bridge.mode,
              command: bridge.command,
              toolsCount: msg.result.tools.length,
              tools: msg.result.tools.map((t) => t.name)
            });
            return;
          }
        } catch {
          // aguarda linha completa
        }
      }
    });

    const rpcPayload =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'guardiao-selftest', version: '1.0.0' }
        }
      }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) +
      '\n';

    proc.stdin.write(rpcPayload);
    proc.stdin.end();
  });
}

/**
 * Fecha por completo e reabre um cliente Desktop (ex: Claude da Store/Desktop, Cursor, Codex, VS Code)
 * para recarregar os servidores MCP sem o funcionário precisar procurar o ícone perto do relógio.
 */
export async function restartAIClient(clientId) {
  const target = getClientTargets().find((t) => t.id === clientId);
  if (!target || !target.canRestart) {
    return { ok: false, message: 'Este programa não suporta reinício automático.' };
  }

  if (process.platform !== 'win32') {
    return {
      ok: false,
      message: `Feche e abra novamente o ${target.name} para recarregar o MCP.`
    };
  }

  try {
    // 1. Descobre AppID no menu Iniciar (funciona para Microsoft Store MSIX e apps Desktop tradicionais)
    let appId = '';
    if (target.appSearchPattern) {
      const psFind = `Get-StartApps | Where-Object { $_.Name -match '${target.appSearchPattern}' } | Select-Object -First 1 -ExpandProperty AppID`;
      appId = execSync(`powershell.exe -NoProfile -Command "${psFind}"`, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    }

    // 2. Descobre caminho executável caso não tenha AppID
    let exePath = '';
    for (const procName of target.processNames) {
      const base = procName.replace(/\.exe$/i, '');
      try {
        const psExe = `(Get-Process -Name '${base}' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`;
        const found = execSync(`powershell.exe -NoProfile -Command "${psExe}"`, {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (found) {
          exePath = found;
          break;
        }
      } catch {
        // ignora
      }
    }

    // 3. Encerra instâncias abertas (incluindo bandeja do sistema)
    for (const procName of target.processNames) {
      try {
        execSync(`taskkill /IM "${procName}" /F`, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore']
        });
      } catch {
        // processo não estava aberto
      }
    }

    await new Promise((r) => setTimeout(r, 900));

    // 4. Reabre de forma desacoplada via Explorer (preserva identidade MSIX da Microsoft Store)
    if (appId) {
      exec(`explorer.exe "shell:AppsFolder\\${appId}"`);
      recentlyInstalledAt.delete(clientId);
      return { ok: true, message: `${target.name} reiniciado com sucesso!` };
    }

    if (exePath && !exePath.toLowerCase().includes('windowsapps')) {
      exec(`explorer.exe "${exePath}"`);
      recentlyInstalledAt.delete(clientId);
      return { ok: true, message: `${target.name} reiniciado com sucesso!` };
    }

    return {
      ok: true,
      message: `${target.name} foi fechado. Abra-o novamente pelo Menu Iniciar.`
    };
  } catch (err) {
    return {
      ok: false,
      message: err?.message || `Feche e abra novamente o ${target.name}.`
    };
  }
}
