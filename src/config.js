import dotenv from 'dotenv';

dotenv.config();

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  port: intEnv('PORT', 3001),
  serviceToken: process.env.SERVICE_TOKEN || '',
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
  authDir: process.env.AUTH_DIR || './auth',
  botName: process.env.BOT_NAME || 'ParanaPOP Bot',
  mediaDownloadTimeoutMs: intEnv('MEDIA_DOWNLOAD_TIMEOUT_MS', 30000),
  maxMediaBytes: intEnv('MAX_MEDIA_BYTES', 15_000_000),
  botPublishEnabled: ['1', 'true', 'yes', 'on', 'sim'].includes(String(process.env.BOT_PUBLISH_ENABLED || '').toLowerCase()),
  botPublishApiUrl: (process.env.BOT_PUBLISH_API_URL || '').trim(),
  botPublishToken: (process.env.BOT_PUBLISH_TOKEN || '').trim(),
  botPublishGroupId: (process.env.BOT_PUBLISH_GROUP_ID || '').trim()
};
