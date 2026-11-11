#!/usr/bin/env node
/**
 * Script de publicação de nova versão do Guardião WhatsApp:
 * 1) Gera o instalador NSIS + latest.yml + .blockmap via electron-builder
 * 2) Envia os artefatos para o GitHub Releases na tag v<version> (usada pelo auto-update)
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const distDir = path.join(rootDir, 'dist');
const exeName = `Guardiao-WhatsApp-Setup-${version}.exe`;
const blockmapName = `${exeName}.blockmap`;

console.log(`\n🛡️  Gerando build ${tag}...`);
execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });

const requiredFiles = ['latest.yml', exeName, blockmapName].map((name) => path.join(distDir, name));
for (const filePath of requiredFiles) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Arquivo esperado não encontrado: ${filePath}`);
    process.exit(1);
  }
}

const releaseNotes = [
  `Versão **${tag}** do Guardião WhatsApp.`,
  '',
  'Usuários a partir da v1.1.0 recebem esta atualização automaticamente pelo próprio aplicativo.',
  '',
  `Requer Windows 10/11 (64 bits).`
].join('\n');

const notesFile = path.join(distDir, 'release-notes.tmp.md');
fs.writeFileSync(notesFile, releaseNotes, 'utf8');

try {
  console.log(`\n🚀 Publicando release ${tag} no GitHub...`);
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      ...requiredFiles,
      '--title',
      `Guardião WhatsApp ${tag}`,
      '--notes-file',
      notesFile
    ],
    { cwd: rootDir, stdio: 'inherit' }
  );
  console.log(`\n✅ Release ${tag} publicado com sucesso!`);
} finally {
  fs.rmSync(notesFile, { force: true });
}
