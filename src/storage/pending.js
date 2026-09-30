import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

export class PendingSamples {
  constructor(directory, { limit = 240, maxBytes = 4194304, retentionSeconds = 3600 } = {}) {
    Object.assign(this, { directory, limit, maxBytes, retentionSeconds });
    this.file = path.join(directory, 'pending.json'); this.items = [];
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      if ((await stat(this.file)).size > this.maxBytes) throw new Error('Pending sample file exceeds configured size bound');
      const items = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(items) || items.some(item => !item.key || !item.sample || !Number.isFinite(Date.parse(item.observedAt)))) throw new Error('Invalid pending sample file');
      this.items = items;
      return this.trim();
    } catch (error) { if (error.code !== 'ENOENT') throw error; return 0; }
  }
  trim() {
    const previous = this.items.length;
    const cutoff = Date.now() - this.retentionSeconds * 1000;
    this.items = this.items.filter(item => Date.parse(item.observedAt) >= cutoff).slice(-this.limit);
    while (Buffer.byteLength(JSON.stringify(this.items)) > this.maxBytes && this.items.length) this.items.shift();
    return previous - this.items.length;
  }
  async persist() {
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.items), { mode: 0o600 });
    await rename(temporary, this.file);
  }
  async add(item) { this.items.push(item); const dropped = this.trim(); await this.persist(); return dropped; }
  async flush(save, onEvent = () => {}) {
    this.trim();
    // Persist a whole successful prefix even if a later write fails. The DB sample
    // key makes retries safe after a commit whose response was lost.
    let completed = 0;
    try {
      for (const item of this.items) {
        const event = await save(item); completed++;
        if (event) onEvent(event);
      }
    } finally {
      this.items.splice(0, completed);
      await this.persist();
    }
  }
}
