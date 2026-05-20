// src/utils/flock.ts
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

export interface FileLock {
  release(): Promise<void>;
}

// Cross-platform exclusive lock via O_CREAT|O_EXCL on a .lock file.
// Bun's fs/promises supports the flag; we retry with exponential backoff.
export async function flock(path: string, timeoutMs = 30_000): Promise<FileLock> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const start = Date.now();
  let delay = 25;
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(`pid=${process.pid}\nts=${new Date().toISOString()}\n`);
      await handle.close();
      return {
        async release() {
          const { unlink } = await import('node:fs/promises');
          await unlink(path).catch(() => undefined);
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`flock: timed out acquiring ${path} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}
