import { removeTemp } from './media.js';

export class SessionStore extends Map {
  constructor({ ttlMs = 30 * 60_000, maxSessions = 20, now = Date.now } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.now = now;
    this.pendingCleanup = new Set();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }
  set(key, value) {
    this.sweep();
    if (!this.has(key) && this.size >= this.maxSessions) throw new Error('Há muitas sessões abertas. Tente novamente em alguns minutos.');
    const old = super.get(key);
    if (old && old !== value) this.dispose(old);
    return super.set(key, value);
  }
  dispose(value) {
    for (const media of [value?.image, value?.video]) {
      if (!media?.path) continue;
      const cleanup = removeTemp(media.path).catch(error => console.warn('Temporary media cleanup failed:', error.message));
      this.pendingCleanup.add(cleanup);
      cleanup.finally(() => this.pendingCleanup.delete(cleanup));
    }
  }
  async flushCleanup() { await Promise.all(this.pendingCleanup); }
  delete(key) {
    this.dispose(super.get(key));
    return super.delete(key);
  }
  clear() {
    for (const value of this.values()) this.dispose(value);
    super.clear();
  }
  sweep() {
    for (const [key, value] of this.entries()) {
      if (['generating', 'publishing'].includes(value.step)) continue;
      if (this.now() - (value.startedAt || value.updatedAt || 0) > this.ttlMs) this.delete(key);
    }
  }
}

export class TaskQueue {
  constructor(maxPending = 10) { this.maxPending = maxPending; this.pending = []; this.active = false; }
  run(task) {
    if (this.pending.length >= this.maxPending) return Promise.reject(Object.assign(new Error('Fila de processamento cheia. Tente novamente em alguns minutos.'), { code: 'RESOURCE_QUEUE_FULL' }));
    return new Promise((resolve, reject) => { this.pending.push({ task, resolve, reject }); this.drain(); });
  }
  async drain() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.pending.length) {
        const { task, resolve, reject } = this.pending.shift();
        try { resolve(await task()); } catch (error) { reject(error); }
      }
    } finally { this.active = false; }
  }
}

export const mediaQueue = new TaskQueue();
