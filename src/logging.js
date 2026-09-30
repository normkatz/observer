import { mkdir } from 'node:fs/promises';
import pino from 'pino';
import { createStream } from 'rotating-file-stream';

export async function createLogger(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stream = createStream('observer.jsonl', { path: directory, size: '5M', maxFiles: 3, mode: 0o600 });
  stream.on('error', error => console.error(`Diagnostic log unavailable: ${error.code || 'WRITE_ERROR'}`));
  const logger = pino({ level: 'info', base: undefined }, pino.multistream([{ stream: process.stdout }, { stream }]));
  return { logger, close: () => new Promise(resolve => { if (stream.destroyed) resolve(); else stream.end(resolve); }) };
}
