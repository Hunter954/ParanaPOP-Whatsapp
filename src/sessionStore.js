import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export async function archiveSession() {
  const source = path.resolve(config.sessionDir);
  const data = path.resolve(config.authDir);
  if (source === data) throw new Error('Configure WA_SESSION_DIR separately before resetting the session.');
  const archive = path.join(data, 'session-backups', String(Date.now()) + '-' + process.pid);
  await fs.mkdir(path.dirname(archive), { recursive: true, mode: 0o700 });
  try { await fs.rename(source, archive); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(source, { recursive: true, mode: 0o700 });
  return archive;
}
