import fs from 'node:fs/promises';
import path from 'node:path';

export const FREE_LIMIT_MESSAGE = '⚠️ Você atingiu o limite de acesso gratuito às ferramentas do Paraná Pop. Para saber mais e liberar o acesso, entre em contato com o fornecedor.';

export function isParanaPopGroup(config, groupId) {
  if (!groupId?.endsWith('@g.us')) return false;
  // Trivox always takes precedence, including a misconfigured shared group ID.
  if ([config.photoTrivoxGroupId, config.videoTrivoxGroupId, config.adminMenuTrivoxGroupId].includes(groupId)) return false;
  return [config.botPublishGroupId, config.photoParanaPopGroupId, config.adminMenuGroupId].includes(groupId);
}

export function createParanaPopAccess(config) {
  const file = path.join(config.authDir, 'paranapop-access.json');
  let blocked = true;
  let loading;
  let writes = Promise.resolve();
  async function load() {
    loading ||= (async () => {
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (typeof data.blocked !== 'boolean') throw new Error('Estado de acesso inválido');
        blocked = data.blocked;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    })();
    await loading;
  }
  return {
    load,
    isBlocked(groupId) { return isParanaPopGroup(config, groupId) && blocked; },
    async setBlocked(value) {
      const operation = writes.then(async () => {
        await load();
        await fs.mkdir(config.authDir, { recursive: true });
        await fs.writeFile(`${file}.tmp`, JSON.stringify({ blocked: value }), 'utf8');
        await fs.rename(`${file}.tmp`, file);
        blocked = value;
      });
      writes = operation.catch(() => {});
      await operation;
    }
  };
}

export async function handleParanaPopAccess({ access, config, message, text, hasSession, isAdmin, reply, clearSessions }) {
  const groupId = message?.key?.remoteJid;
  if (!isParanaPopGroup(config, groupId)) return false;
  const command = text.trim().toLowerCase();
  if (command === '/block' || command === '/unblock') {
    if (!message.key.fromMe && !(await isAdmin())) {
      await reply('⛔ Somente administradores do grupo podem usar /block e /unblock.');
      return true;
    }
    await access.setBlocked(command === '/block');
    clearSessions();
    await reply(command === '/block' ? FREE_LIMIT_MESSAGE : '✅ Acesso ao bot do Paraná Pop liberado. Digite *menu* para acessar as ferramentas.');
    return true;
  }
  if (message?.key?.fromMe || !access.isBlocked(groupId)) return false;
  const toolAttempt = hasSession || /^\//.test(command) || /^\d+$/.test(command) || ['menu', 'voltar', 'sair', 'cancelar'].includes(command);
  if (!toolAttempt) return false;
  await reply(FREE_LIMIT_MESSAGE);
  return true;
}
