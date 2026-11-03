import test from 'node:test';
import assert from 'node:assert/strict';

test('recovery sends to the verified private address and skips an unregistered number', async t => {
  const requestedPhones = [];
  const sent = [];
  const listeners = new Map();
  const socket = {
    ev: { on: (event, fn) => listeners.set(event, fn) },
    async onWhatsApp(phone) {
      requestedPhones.push(phone);
      return phone === '+550000000001'
        ? [{ exists: true, jid: '550000000002@s.whatsapp.net' }]
        : [{ exists: false, jid: '550000000003@s.whatsapp.net' }];
    },
    async sendMessage(jid, payload) {
      sent.push({ jid, ...payload });
      return { key: { id: 'accepted-message' } };
    }
  };
  t.mock.module('@whiskeysockets/baileys', {
    defaultExport: () => socket,
    namedExports: {
      DisconnectReason: { loggedOut: 401 },
      downloadMediaMessage: async () => {},
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} })
    }
  });
  const { startWhatsApp, sendRecoveryCode } = await import('../src/baileysClient.js');
  await startWhatsApp();
  await listeners.get('connection.update')({ connection: 'open' });

  const message = { code: '012345', name: 'Paraná POP' };
  assert.equal(await sendRecoveryCode({ ...message, phone: '+550000000001' }), true);
  assert.equal(await sendRecoveryCode({ ...message, phone: '+550000000003' }), false);
  assert.deepEqual(requestedPhones, ['+550000000001', '+550000000003']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '550000000002@s.whatsapp.net');
  assert.match(sent[0].text, /012345/);
});
