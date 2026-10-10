import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('site publication sends only the limit notice for Paraná Pop; Trivox still sends article; unblock restores news', async (t) => {
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pop-news-'));
  t.after(() => fs.rm(authDir, { recursive: true, force: true }));
  process.env.AUTH_DIR = authDir;
  process.env.PHOTO_PARANAPOP_GROUP_ID = 'pop@g.us';
  process.env.PHOTO_TRIVOX_GROUP_ID = 'trivox@g.us';
  process.env.LOG_LEVEL = 'silent';
  const events = {};
  const sent = [];
  t.mock.module('@whiskeysockets/baileys', {
    defaultExport: () => ({
      ev: { on: (name, callback) => { events[name] = callback; } },
      sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'test' } }; },
      groupMetadata: async () => ({ participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }] })
    }),
    namedExports: {
      DisconnectReason: { loggedOut: 401 }, downloadMediaMessage: async () => { throw new Error('Media must not be downloaded'); },
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} })
    }
  });
  const { startWhatsApp, sendNews, getStatus } = await import('../src/baileysClient.js');
  const { FREE_LIMIT_MESSAGE } = await import('../src/paranaPopAccess.js');
  await startWhatsApp();
  await events['connection.update']({ connection: 'open' });
  assert.equal(getStatus().paranapop_blocked, true);
  const blocked = await sendNews({ group_id: 'pop@g.us', title: 'Matéria', images: [{ url: 'https://invalid.example/art.jpg' }], generate_standard_art: true });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.sent_images, []);
  assert.deepEqual(sent, [{ jid: 'pop@g.us', content: { text: FREE_LIMIT_MESSAGE } }]);
  sent.length = 0;
  const trivox = await sendNews({ group_id: 'trivox@g.us', portal_name: 'Portal Trivox', title: 'Notícia Trivox', url: 'https://trivox.example/noticia' });
  assert.equal(trivox.blocked, undefined);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content.text, /Notícia Trivox/);
  await events['messages.upsert']({ messages: [{ key: { remoteJid: 'pop@g.us', participant: 'admin@s.whatsapp.net' }, message: { conversation: '/unblock' } }] });
  assert.equal(getStatus().paranapop_blocked, false);
  sent.length = 0;
  await sendNews({ group_id: 'pop@g.us', title: 'Nova matéria liberada' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].content.text, /Nova matéria liberada/);
});
