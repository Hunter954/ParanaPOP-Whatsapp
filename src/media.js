import axios from 'axios';
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import FormData from 'form-data';
import { config } from './config.js';

const TMP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tmp');
const owned = new Map();
const removals = new Map();
const capabilityCache = new Map();
let tempBytes = 0;
const maxTempBytes = Number(process.env.MAX_TEMP_MEDIA_BYTES) || 256_000_000;

export async function ensureTmpDir() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  // This directory contains only ephemeral media created by this module.
  for (const entry of await fs.readdir(TMP_DIR)) {
    if (entry.startsWith('media-')) await fs.rm(path.join(TMP_DIR, entry), { force: true });
  }
}

export async function removeTemp(file) {
  if (removals.has(file)) return removals.get(file);
  if (!owned.has(file)) return;
  const cleanup = fs.rm(file, { force: true }).then(() => {
    tempBytes -= owned.get(file) || 0;
    owned.delete(file);
  }).finally(() => removals.delete(file));
  removals.set(file, cleanup);
  return cleanup;
}

export function tempMediaStats() { return { files: owned.size, bytes: tempBytes }; }

export async function saveMediaStream(stream, maxBytes, mimetype = 'application/octet-stream') {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `media-${randomUUID()}`);
  let size = 0;
  owned.set(file, 0);
  const limiter = new Transform({ transform(chunk, _encoding, callback) {
    if (size + chunk.length > maxBytes || tempBytes + chunk.length > maxTempBytes) {
      return callback(new Error('Mídia excede o limite de tamanho ou de armazenamento temporário.'));
    }
    size += chunk.length;
    tempBytes += chunk.length;
    owned.set(file, size);
    callback(null, chunk);
  } });
  try {
    await pipeline(stream, limiter, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    return { path: file, size, mimetype };
  } catch (error) {
    await removeTemp(file);
    throw error;
  }
}

function guessMimeFromUrl(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return 'video/mp4';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

export async function mediaFromUrl(url, maxBytes = config.maxMediaBytes) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('URL de mídia inválida.');
  const response = await axios.get(url, { responseType: 'stream', timeout: config.mediaDownloadTimeoutMs,
    maxContentLength: maxBytes, validateStatus: status => status >= 200 && status < 300 });
  if (Number(response.headers['content-length'] || 0) > maxBytes) {
    response.data.destroy();
    throw new Error('Mídia excede o limite de tamanho.');
  }
  return saveMediaStream(response.data, maxBytes, response.headers['content-type'] || guessMimeFromUrl(url));
}

export async function mediaFromPath(localPath, maxBytes = config.maxMediaBytes) {
  const resolved = path.resolve(localPath || '');
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Mídia inválida ou maior que o limite.');
  return { path: resolved, size: stat.size, mimetype: guessMimeFromUrl(resolved) };
}

export async function resolveMedia(input, options = {}) {
  if (!input) throw new Error('Mídia ausente.');
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : config.maxMediaBytes;
  return /^https?:\/\//i.test(input) ? mediaFromUrl(input, maxBytes) : mediaFromPath(input, maxBytes);
}

async function supportsMultipart(url) {
  const cached = capabilityCache.get(url);
  if (cached && Date.now() - cached.at < 300_000) return cached.supported;
  let supported = false;
  try {
    const response = await axios.options(url, { timeout: 5000 });
    supported = response.headers['x-media-upload'] === 'multipart';
  } catch { /* Old portal deployments still accept the bounded JSON protocol. */ }
  if (capabilityCache.size >= 16) capabilityCache.delete(capabilityCache.keys().next().value);
  capabilityCache.set(url, { at: Date.now(), supported });
  return supported;
}

export async function postMedia(url, token, fields, media, kind, timeout = 90_000) {
  if (!media?.path) throw new Error('Arquivo de mídia ausente.');
  const filename = media.filename || `${kind}.${kind === 'video' ? 'mp4' : 'jpg'}`;
  if (await supportsMultipart(url)) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...fields, token })) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    form.append(kind, createReadStream(media.path), { filename, contentType: media.mimetype, knownLength: media.size });
    return (await axios.post(url, form, { timeout, headers: { ...form.getHeaders(), 'X-Bot-Token': token },
      maxBodyLength: media.size + 1_000_000, maxContentLength: 2_000_000 })).data;
  }
  // Compatibility for external portals that have not yet upgraded; never stored in a session.
  const body = { ...fields, token, [`${kind}_base64`]: (await fs.readFile(media.path)).toString('base64'),
    [`${kind}_mimetype`]: media.mimetype, [`${kind}_filename`]: filename };
  return (await axios.post(url, body, { timeout, headers: { 'X-Bot-Token': token },
    maxBodyLength: Math.ceil(media.size * 1.5) + 1_000_000, maxContentLength: 2_000_000 })).data;
}
