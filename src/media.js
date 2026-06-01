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
  return 'image/jpeg';
}

export async function mediaFromUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(`URL de mídia inválida: ${url}`);
  }

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: config.mediaDownloadTimeoutMs,
    maxContentLength: config.maxMediaBytes,
    maxBodyLength: config.maxMediaBytes,
    validateStatus: (status) => status >= 200 && status < 300
  });

  const contentLength = Number.parseInt(response.headers['content-length'] || '0', 10);
  if (contentLength && contentLength > config.maxMediaBytes) {
    throw new Error(`Imagem excede o limite de ${config.maxMediaBytes} bytes.`);
  }

  const buffer = Buffer.from(response.data);
  if (buffer.length > config.maxMediaBytes) {
    throw new Error(`Imagem excede o limite de ${config.maxMediaBytes} bytes.`);
  }

  return {
    buffer,
    mimetype: response.headers['content-type'] || guessMimeFromUrl(url)
  };
}

export async function mediaFromPath(localPath) {
  if (!localPath) throw new Error('Caminho local da mídia ausente.');
  const resolved = path.resolve(localPath);
  const buffer = await fs.readFile(resolved);
  if (buffer.length > config.maxMediaBytes) {
    throw new Error(`Imagem excede o limite de ${config.maxMediaBytes} bytes.`);
  }
  return { buffer, mimetype: guessMimeFromUrl(resolved) };
}

export async function resolveMedia(input) {
  if (!input) throw new Error('Mídia ausente. Envie image_url ou image_path.');
  if (/^https?:\/\//i.test(input)) return mediaFromUrl(input);
  return mediaFromPath(input);
}
