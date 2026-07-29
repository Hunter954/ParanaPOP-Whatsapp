import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TMP_DIR = path.resolve(__dirname, '..', 'data', 'tmp');

export async function ensureTmpDir() {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

function guessMimeFromUrl(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.jpeg') || clean.endsWith('.jpg')) return 'image/jpeg';
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return 'video/mp4';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

export async function mediaFromUrl(url, maxBytes = config.maxMediaBytes) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(`URL de mídia inválida: ${url}`);
  }

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: config.mediaDownloadTimeoutMs,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    validateStatus: (status) => status >= 200 && status < 300
  });

  const contentLength = Number.parseInt(response.headers['content-length'] || '0', 10);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Mídia excede o limite de ${maxBytes} bytes.`);
  }

  const buffer = Buffer.from(response.data);
  if (buffer.length > maxBytes) {
    throw new Error(`Mídia excede o limite de ${maxBytes} bytes.`);
  }

  return {
    buffer,
    mimetype: response.headers['content-type'] || guessMimeFromUrl(url)
  };
}

export async function mediaFromPath(localPath, maxBytes = config.maxMediaBytes) {
  if (!localPath) throw new Error('Caminho local da mídia ausente.');
  const resolved = path.resolve(localPath);
  const buffer = await fs.readFile(resolved);
  if (buffer.length > maxBytes) {
    throw new Error(`Mídia excede o limite de ${maxBytes} bytes.`);
  }
  return { buffer, mimetype: guessMimeFromUrl(resolved) };
}

export async function resolveMedia(input, options = {}) {
  if (!input) throw new Error('Mídia ausente. Envie image_url ou image_path.');
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : config.maxMediaBytes;
  if (/^https?:\/\//i.test(input)) return mediaFromUrl(input, maxBytes);
  return mediaFromPath(input, maxBytes);
}
