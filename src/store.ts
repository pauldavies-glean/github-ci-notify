import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import logger from 'electron-log';

const MAX_IDS_PER_REPO = 200;

let storePath = '';
let store: Record<string, number[]> = {};

export function initStore(): void {
  storePath = path.join(app.getPath('userData'), 'seen.json');

  if (fs.existsSync(storePath)) {
    try {
      store = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as Record<string, number[]>;
    } catch (err) {
      logger.warn(`Failed to read seen.json (resetting): ${String(err)}`);
      store = {};
    }
  }
}

export function getSeenIds(repo: string): Set<number> {
  return new Set(store[repo] ?? []);
}

export function markSeen(repo: string, ids: number[]): void {
  const existing = store[repo] ?? [];
  const merged = [...new Set([...existing, ...ids])];
  store[repo] = merged.slice(-MAX_IDS_PER_REPO);
  flush();
}

function flush(): void {
  try {
    fs.writeFileSync(storePath, JSON.stringify(store), 'utf-8');
  } catch (err) {
    logger.warn(`Failed to flush seen.json: ${String(err)}`);
  }
}
