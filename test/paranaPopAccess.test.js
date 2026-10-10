import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createParanaPopAccess, handleParanaPopAccess, FREE_LIMIT_MESSAGE } from '../src/paranaPopAccess.js';

async function fixture(t) {
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pop-access-'));
  t.after(() => fs.rm(authDir, { recursive: true, force: true }));
  const config = { authDir, photoParanaPopGroupId: 'pop@g.us', photoTrivoxGroupId: 'trivox@g.us' };
  const access = createParanaPopAccess(config);
  await access.load();
  const replies = [];
  let resets = 0;
  const args = {
    config, access, text: 'menu', message: { key: { remoteJid: 'pop@g.us', fromMe: false } },
    hasSession: false, isAdmin: async () => false,
    reply: async (value) => replies.push(value), clearSessions: () => resets++
  };
  return { config, access, args, replies, resets: () => resets };
}

test('starts blocked only for Paraná Pop, leaving Trivox and unrelated groups available', async (t) => {
  const { access, args, replies } = await fixture(t);
  assert.equal(access.isBlocked('pop@g.us'), true);
  for (const id of ['trivox@g.us', 'other@g.us', 'person@s.whatsapp.net']) assert.equal(access.isBlocked(id), false);
  assert.equal(await handleParanaPopAccess(args), true);
  assert.deepEqual(replies, [FREE_LIMIT_MESSAGE]);
  assert.equal(await handleParanaPopAccess({ ...args, message: { key: { remoteJid: 'trivox@g.us' } } }), false);
});

test('non-admin cannot unblock; admin can unblock and block with persistence across restart', async (t) => {
  const { access, args, config, resets } = await fixture(t);
  await handleParanaPopAccess({ ...args, text: '/unblock' });
  assert.equal(access.isBlocked('pop@g.us'), true);
  await handleParanaPopAccess({ ...args, text: '/unblock', isAdmin: async () => true });
  assert.equal(access.isBlocked('pop@g.us'), false);
  const restarted = createParanaPopAccess(config);
  await restarted.load();
  assert.equal(restarted.isBlocked('pop@g.us'), false);
  assert.equal(await handleParanaPopAccess(args), false);
  await handleParanaPopAccess({ ...args, text: '/block', isAdmin: async () => true });
  assert.equal(access.isBlocked('pop@g.us'), true);
  assert.equal(resets(), 2);
  const restartedAgain = createParanaPopAccess(config);
  await restartedAgain.load();
  assert.equal(restartedAgain.isBlocked('pop@g.us'), true);
});

test('bot account controls access without processing its own warning; ordinary conversation is ignored', async (t) => {
  const { access, args } = await fixture(t);
  assert.equal(await handleParanaPopAccess({ ...args, text: 'Olá, pessoal!' }), false);
  assert.equal(await handleParanaPopAccess({ ...args, text: FREE_LIMIT_MESSAGE, message: { key: { remoteJid: 'pop@g.us', fromMe: true } } }), false);
  await handleParanaPopAccess({ ...args, text: '/unblock', message: { key: { remoteJid: 'pop@g.us', fromMe: true } } });
  assert.equal(access.isBlocked('pop@g.us'), false);
});

test('all tool commands, numeric options and ongoing flows are intercepted', async (t) => {
  const { args } = await fixture(t);
  for (const text of ['/foto', '/video', '/publicar', '/clear', '/menu', '7', 'voltar']) {
    assert.equal(await handleParanaPopAccess({ ...args, text }), true, text);
  }
  assert.equal(await handleParanaPopAccess({ ...args, text: 'Título da matéria', hasSession: true }), true);
});

test('Trivox wins if group configuration overlaps and cannot change Paraná Pop state', async (t) => {
  const { args, access, config } = await fixture(t);
  config.adminMenuTrivoxGroupId = 'pop@g.us';
  assert.equal(access.isBlocked('pop@g.us'), false);
  assert.equal(await handleParanaPopAccess({ ...args, text: '/block', isAdmin: async () => true }), false);
});

test('corrupt state fails closed; failed writes do not unlock; concurrent changes save in order', async (t) => {
  const { access, config } = await fixture(t);
  await Promise.all([access.setBlocked(false), access.setBlocked(true)]);
  assert.equal(access.isBlocked('pop@g.us'), true);
  await fs.rm(config.authDir, { recursive: true });
  await fs.writeFile(config.authDir, 'not a directory');
  await assert.rejects(access.setBlocked(false));
  assert.equal(access.isBlocked('pop@g.us'), true);
  await fs.rm(config.authDir);
  await fs.mkdir(config.authDir);
  await fs.writeFile(path.join(config.authDir, 'paranapop-access.json'), 'invalid json');
  await assert.rejects(createParanaPopAccess(config).load());
});
