import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { requireServiceToken } from './security.js';
import { ensureTmpDir } from './media.js';
import {
  getQr,
  getStatus,
  listGroups,
  logoutWhatsApp,
  sendImage,
  sendMessage,
  sendNews,
  startWhatsApp
} from './baileysClient.js';

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origem não permitida: ${origin}`));
    }
  })
);

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'paranapop-whatsapp-service' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/status', requireServiceToken, (req, res) => {
  res.json(getStatus());
});

app.get('/qr', requireServiceToken, (req, res) => {
  res.json(getQr());
});

app.get('/groups', requireServiceToken, asyncRoute(async (req, res) => {
  res.json(await listGroups());
}));

app.post('/logout', requireServiceToken, asyncRoute(async (req, res) => {
  res.json(await logoutWhatsApp());
}));

app.post('/send-message', requireServiceToken, asyncRoute(async (req, res) => {
  res.json(await sendMessage(req.body));
}));

app.post('/send-image', requireServiceToken, asyncRoute(async (req, res) => {
  res.json(await sendImage(req.body));
}));

app.post('/send-news', requireServiceToken, asyncRoute(async (req, res) => {
  res.json(await sendNews(req.body));
}));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    ok: false,
    error: error?.name || 'Error',
    message: error?.message || 'Erro interno no serviço WhatsApp.'
  });
});

await ensureTmpDir();
await startWhatsApp();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`ParanaPOP WhatsApp service rodando na porta ${config.port}`);
});
