import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import QRCode from 'qrcode';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { config } from './config.js';
import { resolveMedia } from './media.js';

const logger = P({ level: process.env.LOG_LEVEL || 'info' });

let sock = null;
let qrText = null;
let qrDataUrl = null;
let connected = false;
let starting = false;
let lastConnectionUpdate = null;
let lastError = null;
let reconnectTimer = null;
const publishSessions = new Map();

function botEnabled() {
  return Boolean(config.botPublishEnabled && config.botPublishApiUrl && config.botPublishToken);
}

function textFromMessage(message) {
  const m = message?.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function imageMessageContent(message) {
  return message?.message?.imageMessage || null;
}

function sessionKey(remoteJid, participant) {
  return `${remoteJid || 'chat'}:${participant || 'user'}`;
}

async function replyMessage(jid, text) {
  if (!sock || !jid || !text) return;
  await sock.sendMessage(jid, { text });
}

function commandAllowed(remoteJid) {
  if (!botEnabled()) return false;
  if (config.botPublishGroupId && remoteJid !== config.botPublishGroupId) return false;
  return true;
}

async function imageToPayload(message) {
  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );
  const mimetype = imageMessageContent(message)?.mimetype || 'image/jpeg';
  return {
    image_base64: buffer.toString('base64'),
    image_mimetype: mimetype,
    image_filename: `whatsapp-${Date.now()}.${mimetype.includes('png') ? 'png' : mimetype.includes('webp') ? 'webp' : 'jpg'}`
  };
}

async function publishToSite(session) {
  const response = await axios.post(
    config.botPublishApiUrl,
    {
      token: config.botPublishToken,
      title: session.title,
      content: session.content,
      ...session.image
    },
    {
      timeout: 60000,
      headers: {
        'X-Bot-Token': config.botPublishToken,
        'Content-Type': 'application/json'
      },
      maxBodyLength: config.maxMediaBytes + 2_000_000
    }
  );
  return response.data;
}

async function handlePublishBot(message) {
  const remoteJid = message?.key?.remoteJid;
  const participant = message?.key?.participant || message?.key?.remoteJid;
  const fromMe = Boolean(message?.key?.fromMe);
  if (fromMe || !remoteJid || !remoteJid.endsWith('@g.us')) return;

  const text = textFromMessage(message);
  const key = sessionKey(remoteJid, participant);

  if (text.toLowerCase() === '/publicar') {
    if (!commandAllowed(remoteJid)) {
      await replyMessage(remoteJid, '🤖 Bot Publicar ainda não está configurado/ativo para este grupo. Confira o menu Admin > Bot Publicar.');
      return;
    }
    publishSessions.set(key, { step: 'image', startedAt: Date.now() });
    await replyMessage(remoteJid, '🚀 Vamos publicar uma matéria nova. Primeiro, envie a imagem principal da matéria.');
    return;
  }

  if (text.toLowerCase() === '/cancelar') {
    if (publishSessions.delete(key)) {
      await replyMessage(remoteJid, 'Publicação cancelada. Quando quiser começar de novo, digite /publicar.');
    }
    return;
  }

  const session = publishSessions.get(key);
  if (!session) return;

  if (Date.now() - session.startedAt > 30 * 60 * 1000) {
    publishSessions.delete(key);
    await replyMessage(remoteJid, '⏰ Essa publicação expirou. Digite /publicar para começar novamente.');
    return;
  }

  try {
    if (session.step === 'image') {
      if (!imageMessageContent(message)) {
        await replyMessage(remoteJid, '📸 Agora preciso da imagem da matéria. Envie uma foto/imagem ou digite /cancelar.');
        return;
      }
      session.image = await imageToPayload(message);
      session.step = 'title';
      publishSessions.set(key, session);
      await replyMessage(remoteJid, 'Imagem recebida ✅ Agora envie o título da matéria.');
      return;
    }

    if (session.step === 'title') {
      if (!text || text.length < 5) {
        await replyMessage(remoteJid, 'Me envie um título um pouco maior para a matéria.');
        return;
      }
      session.title = text.slice(0, 500);
      session.step = 'content';
      publishSessions.set(key, session);
      await replyMessage(remoteJid, 'Título salvo ✅ Agora envie o texto completo da matéria.');
      return;
    }

    if (session.step === 'content') {
      if (!text || text.length < 20) {
        await replyMessage(remoteJid, 'O texto parece curto demais. Envie o conteúdo completo da matéria ou /cancelar.');
        return;
      }
      session.content = text;
      session.step = 'publishing';
      publishSessions.set(key, session);
      await replyMessage(remoteJid, '🛠️ Recebi tudo. Estou publicando a matéria agora...');
      const result = await publishToSite(session);
      publishSessions.delete(key);
      if (result?.ok) {
        await replyMessage(remoteJid, `✅ Matéria publicada com sucesso!\n\n${result.title || session.title}\n${result.url || ''}`.trim());
      } else {
        await replyMessage(remoteJid, `⚠️ Não consegui publicar: ${result?.message || 'erro desconhecido'}`);
      }
    }
  } catch (error) {
    logger.error({ error }, 'Erro no Bot Publicar');
    publishSessions.delete(key);
    await replyMessage(remoteJid, `⚠️ Deu erro ao publicar: ${error?.response?.data?.message || error?.message || 'erro interno'}`);
  }
}


async function setQr(qr) {
  qrText = qr || null;
  qrDataUrl = qr ? await QRCode.toDataURL(qr, { margin: 1, width: 320 }) : null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch((error) => {
      lastError = error.message;
      logger.error({ error }, 'Erro ao reconectar WhatsApp');
      scheduleReconnect();
    });
  }, 3000);
}

export async function startWhatsApp() {
  if (starting) return;
  starting = true;

  try {
    await fs.mkdir(config.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: [config.botName, 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const message of messages || []) {
        await handlePublishBot(message);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      lastConnectionUpdate = update;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connected = false;
        await setQr(qr);
        logger.info('Novo QR Code disponível');
      }

      if (connection === 'open') {
        connected = true;
        lastError = null;
        await setQr(null);
        logger.info('WhatsApp conectado');
      }

      if (connection === 'close') {
        connected = false;
        await setQr(null);

        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        lastError = lastDisconnect?.error?.message || `Conexão fechada (${statusCode || 'sem código'})`;

        logger.warn({ statusCode, error: lastError }, 'WhatsApp desconectado');

        if (statusCode !== DisconnectReason.loggedOut) {
          scheduleReconnect();
        } else {
          logger.warn('Sessão deslogada. Será necessário escanear novo QR Code.');
        }
      }
    });
  } finally {
    starting = false;
  }
}

export function getStatus() {
  return {
    ok: true,
    status: connected ? 'Conectado' : (qrText ? 'Aguardando QR Code' : 'Desconectado'),
    state: connected ? 'connected' : (qrText ? 'qr' : 'disconnected'),
    connected,
    has_qr: Boolean(qrText),
    qr: qrText,
    qr_data_url: qrDataUrl,
    phone: sock?.user?.id || null,
    user: sock?.user || null,
    last_error: lastError,
    last_update: lastConnectionUpdate
      ? {
          connection: lastConnectionUpdate.connection || null,
          received_pending_notifications: lastConnectionUpdate.receivedPendingNotifications || null
        }
      : null
  };
}

export function getQr() {
  return {
    ok: true,
    connected,
    has_qr: Boolean(qrText),
    qr: qrText,
    qr_data_url: qrDataUrl
  };
}

export async function logoutWhatsApp() {
  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      logger.warn({ error }, 'Falha ao fazer logout pelo socket');
    }
  }
  connected = false;
  await setQr(null);
  try {
    await fs.rm(config.authDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ error }, 'Falha ao remover diretório de auth');
  }
  scheduleReconnect();
  return { ok: true };
}

function ensureConnected() {
  if (!sock || !connected) {
    throw new Error('WhatsApp ainda não está conectado. Escaneie o QR Code no admin.');
  }
}

export async function listGroups() {
  ensureConnected();
  const chats = await sock.groupFetchAllParticipating();
  const groups = Object.values(chats)
    .map((group) => ({
      id: group.id,
      name: group.subject,
      participants: group.participants?.length || 0,
      participants_count: group.participants?.length || 0,
      owner: group.owner || null,
      announce: Boolean(group.announce),
      restrict: Boolean(group.restrict)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  return { ok: true, groups };
}

export async function sendMessage({ group_id, message }) {
  ensureConnected();
  if (!group_id) throw new Error('group_id ausente.');
  if (!message) throw new Error('message ausente.');

  const result = await sock.sendMessage(group_id, { text: message });
  return { ok: true, message_id: result?.key?.id || null };
}

export async function sendImage({ group_id, image_url, image_path, caption }) {
  ensureConnected();
  if (!group_id) throw new Error('group_id ausente.');

  const media = await resolveMedia(image_url || image_path);
  const result = await sock.sendMessage(group_id, {
    image: media.buffer,
    mimetype: media.mimetype,
    caption: caption || ''
  });

  return { ok: true, message_id: result?.key?.id || null };
}

function pickUrl(item) {
  return item?.url || item?.image_url || item?.public_url || item?.path || item?.image_path || null;
}

function labelForFormat(format) {
  const normalized = String(format || '').toLowerCase();
  if (normalized.includes('stories') || normalized.includes('story')) return 'Stories';
  if (normalized.includes('facebook')) return 'Facebook';
  if (normalized.includes('feed')) return 'Feed';
  return format || 'Arte';
}

export async function sendNews(payload) {
  ensureConnected();

  const groupId = payload.group_id;
  if (!groupId) throw new Error('group_id ausente.');

  const post = payload.post || {};
  const title = payload.title || payload.titulo || post.title || 'Nova matéria';
  const url = payload.url || payload.post_url || post.url || '';
  const summary = payload.summary || payload.resumo || post.summary || '';
  const instagramDescription = payload.instagram_description || payload.description || payload.descricao_instagram || payload.caption || '';
  const images = Array.isArray(payload.images) ? payload.images : [];

  const sent = [];

  for (const image of images) {
    const mediaUrl = pickUrl(image);
    if (!mediaUrl) continue;

    const formatLabel = labelForFormat(image.format || image.type || image.name);
    const caption = `Arte ${formatLabel} - ${title}`;
    const result = await sendImage({
      group_id: groupId,
      image_url: /^https?:\/\//i.test(mediaUrl) ? mediaUrl : undefined,
      image_path: /^https?:\/\//i.test(mediaUrl) ? undefined : mediaUrl,
      caption
    });

    sent.push({ format: formatLabel, ...result });
  }

  const textParts = [
    `📰 Nova matéria publicada no Paraná Pop`,
    '',
    `Título: ${title}`
  ];

  if (summary) {
    textParts.push('', `Resumo: ${summary}`);
  }

  if (instagramDescription) {
    textParts.push('', `Descrição sugerida para Instagram/Facebook:`, instagramDescription);
  }

  if (url) {
    textParts.push('', `Link da matéria:`, url);
  }

  const textResult = await sendMessage({
    group_id: groupId,
    message: textParts.join('\n')
  });

  return {
    ok: true,
    sent_images: sent,
    sent_text: textResult
  };
}
