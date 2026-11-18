#!/usr/bin/env node
/**
 * Corrige bug conhecido do Baileys 6.7.16 ao reenviar mensagens (retry receipt)
 * para dispositivos próprios ou contatos que usam endereço @lid:
 * - Preserva `server` ('lid' vs 's.whatsapp.net') no `participant` do retry
 * - Reconhece `me.lid` como dispositivo próprio (`meJids` com `deviceSentMessage`)
 * Sem isso, o WhatsApp Web/Desktop fica preso em "Aguardando mensagem. Essa ação pode levar alguns instantes."
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baileySocketDir = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '@whiskeysockets',
  'baileys',
  'lib',
  'Socket'
);
const targetFile = path.join(baileySocketDir, 'messages-send.js');
const recvFile = path.join(baileySocketDir, 'messages-recv.js');

if (!fs.existsSync(targetFile)) {
  console.log('ℹ️  Baileys não encontrado em node_modules; pulando patch.');
  process.exit(0);
}

let src = fs.readFileSync(targetFile, 'utf8');

if (src.includes('/* GUARDIAO_LID_RETRY_FIX */')) {
  console.log('✅ Patch Baileys @lid retry já aplicado.');
} else {
  const oldParticipantBlock = `            const { user, device } = jidDecode(participant.jid);
            devices.push({ user, device });`;

  const newParticipantBlock = `            /* GUARDIAO_LID_RETRY_FIX */
            const { user, device, server: participantServer } = jidDecode(participant.jid);
            devices.push({ user, device, server: participantServer });`;

  const oldLoopBlock = `                const { user: meUser } = jidDecode(meId);
                if (!participant) {
                    devices.push({ user });
                    if (user !== meUser) {
                        devices.push({ user: meUser });
                    }
                    if (additionalAttributes?.['category'] !== 'peer') {
                        const additionalDevices = await getUSyncDevices([meId, jid], !!useUserDevicesCache, true);
                        devices.push(...additionalDevices);
                    }
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device } of devices) {
                    const isMe = user === meUser;
                    const jid = jidEncode(isMe && isLid ? authState.creds?.me?.lid.split(':')[0] || user : user, isLid ? 'lid' : 's.whatsapp.net', device);`;

  const newLoopBlock = `                const { user: meUser } = jidDecode(meId);
                const meLidUser = authState.creds?.me?.lid ? jidDecode(authState.creds.me.lid)?.user : undefined;
                if (!participant) {
                    devices.push({ user });
                    if (user !== meUser) {
                        devices.push({ user: meUser });
                    }
                    if (additionalAttributes?.['category'] !== 'peer') {
                        const additionalDevices = await getUSyncDevices([meId, jid], !!useUserDevicesCache, true);
                        devices.push(...additionalDevices);
                    }
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device, server: devServer } of devices) {
                    const isMe = user === meUser || (Boolean(meLidUser) && user === meLidUser);
                    const targetServer = devServer || (isLid ? 'lid' : 's.whatsapp.net');
                    const targetUser = isMe && targetServer === 'lid' ? (meLidUser || user) : (isMe ? meUser : user);
                    const jid = jidEncode(targetUser, targetServer, device);`;

  if (!src.includes(oldParticipantBlock) || !src.includes(oldLoopBlock)) {
    console.error('❌ Estrutura inesperada em messages-send.js ao aplicar patch @lid.');
    process.exit(1);
  }

  src = src.replace(oldParticipantBlock, newParticipantBlock).replace(oldLoopBlock, newLoopBlock);
  fs.writeFileSync(targetFile, src, 'utf8');
  console.log('✅ Patch Baileys @lid retry aplicado com sucesso.');
}

if (fs.existsSync(recvFile)) {
  let recvSrc = fs.readFileSync(recvFile, 'utf8');
  if (recvSrc.includes('/* GUARDIAO_RETRY_KEYS_FIX */')) {
    console.log('✅ Patch Baileys forceIncludeKeys já aplicado.');
  } else {
    const oldRetryLine = `                                const encNode = getBinaryNodeChild(node, 'enc');
                                await sendRetryRequest(node, !encNode);`;
    const newRetryLine = `                                /* GUARDIAO_RETRY_KEYS_FIX */
                                const encNode = getBinaryNodeChild(node, 'enc');
                                const stubReason = String(msg?.messageStubParameters?.[0] || '');
                                const missingSession = /no (matching )?session/i.test(stubReason);
                                await sendRetryRequest(node, !encNode || missingSession);`;
    if (!recvSrc.includes(oldRetryLine)) {
      console.error('❌ Estrutura inesperada em messages-recv.js ao aplicar patch forceIncludeKeys.');
      process.exit(1);
    }
    recvSrc = recvSrc.replace(oldRetryLine, newRetryLine);
    fs.writeFileSync(recvFile, recvSrc, 'utf8');
    console.log('✅ Patch Baileys forceIncludeKeys aplicado com sucesso.');
  }
}
