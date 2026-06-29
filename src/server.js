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
  res.json({
    ...getStatus(),
    bot_publicar: {
      enabled: config.botPublishEnabled,
      configured: Boolean(config.botPublishApiUrl && config.botPublishToken),
      group_id: config.botPublishGroupId || null
    }
  });
});

app.get('/qr', requireServiceToken, (req, res) => {
  res.json(getQr());
});


app.get('/qr.html', requireServiceToken, (req, res) => {
  const qr = getQr();
  if (qr.connected) {
    return res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp conectado</title><style>body{font-family:Arial,sans-serif;background:#f6f7fb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border-radius:18px;padding:32px;box-shadow:0 10px 30px rgba(15,23,42,.12);text-align:center;max-width:420px}h1{font-size:22px;margin:0 0 10px;color:#0f172a}p{color:#475569}</style></head><body><div class="card"><h1>WhatsApp conectado ✅</h1><p>Você já pode voltar no admin do Paraná Pop, carregar os grupos e enviar o teste.</p></div></body></html>`);
  }
  if (!qr.has_qr || !qr.qr_data_url) {
    return res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Aguardando QR</title><style>body{font-family:Arial,sans-serif;background:#f6f7fb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border-radius:18px;padding:32px;box-shadow:0 10px 30px rgba(15,23,42,.12);text-align:center;max-width:420px}h1{font-size:22px;margin:0 0 10px;color:#0f172a}p{color:#475569}</style></head><body><div class="card"><h1>Aguardando QR Code...</h1><p>Atualize em alguns segundos. Se demorar, confira os logs do serviço no Railway.</p></div></body></html>`);
  }
  return res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Conectar WhatsApp</title><style>body{font-family:Arial,sans-serif;background:#f6f7fb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border-radius:18px;padding:32px;box-shadow:0 10px 30px rgba(15,23,42,.12);text-align:center;max-width:460px}h1{font-size:24px;margin:0 0 8px;color:#0f172a}p{color:#475569;line-height:1.45}img{width:320px;height:320px;max-width:100%;border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#fff}.small{font-size:13px;color:#64748b}</style></head><body><div class="card"><h1>Conectar WhatsApp</h1><p>Abra o WhatsApp no celular: <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> e escaneie o QR Code.</p><img src="${qr.qr_data_url}" alt="QR Code WhatsApp"><p class="small">Esta página atualiza sozinha. Depois de conectar, volte no admin do Paraná Pop.</p></div></body></html>`);
});

app.get('/qr.png', requireServiceToken, (req, res) => {
  const qr = getQr();
  if (!qr.has_qr || !qr.qr_data_url) {
    return res.status(404).json({ ok: false, message: qr.connected ? 'WhatsApp já conectado.' : 'QR Code ainda não disponível.' });
  }
  const base64 = qr.qr_data_url.split(',')[1];
  const buffer = Buffer.from(base64, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(buffer);
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
