import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface ManualWatch {
  repo: string;
  runId: number;
  name: string;
  branch: string;
  runNumber: number;
  addedAt: number;
}

let watchPath = '';
let watches: ManualWatch[] = [];

export function initManualWatch(): void {
  watchPath = path.join(app.getPath('userData'), 'manual-watch.json');
  if (fs.existsSync(watchPath)) {
    try {
      watches = JSON.parse(fs.readFileSync(watchPath, 'utf-8')) as ManualWatch[];
    } catch {
      watches = [];
    }
  }
}

export function getWatches(): ManualWatch[] {
  return [...watches];
}

export function hasWatch(repo: string, runId: number): boolean {
  return watches.some(w => w.repo === repo && w.runId === runId);
}

export function addWatch(w: ManualWatch): void {
  if (hasWatch(w.repo, w.runId)) return;
  watches.push(w);
  flush();
}

export function removeWatch(repo: string, runId: number): void {
  watches = watches.filter(w => !(w.repo === repo && w.runId === runId));
  flush();
}

function flush(): void {
  try {
    fs.writeFileSync(watchPath, JSON.stringify(watches), 'utf-8');
  } catch {
    // non-fatal
  }
}
