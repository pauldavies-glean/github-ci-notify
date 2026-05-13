import { Tray, Menu, app, clipboard, shell } from 'electron';
import * as path from 'path';
import logger from 'electron-log';
import { pausePolling, resumePolling, isPaused, ActiveRuns, fetchSingleRun, resolveRunId } from './poller';
import { RepoConfig } from './config';
import { parseRunInput } from './parse-input';
import { getWatches, addWatch, removeWatch, hasWatch, ManualWatch } from './manual-watch';
import { showNotification } from './notifier';

let tray: Tray | null = null;
let _repos: RepoConfig[] = [];
let _active: ActiveRuns = new Map();

async function watchFromClipboard(): Promise<void> {
  const text = clipboard.readText();
  const parsed = parseRunInput(text);
  if (!parsed) {
    showNotification({
      title: 'Watch run',
      body: 'Clipboard does not contain a run URL or numeric run ID',
    });
    return;
  }

  let resolved: { repo: string; runId: number; run: { id: number; name: string; head_branch: string; run_number: number; status: string } } | null = null;

  if (parsed.kind === 'with-repo') {
    const run = await fetchSingleRun(parsed.repo, parsed.runId);
    if (run) resolved = { repo: parsed.repo, runId: parsed.runId, run };
  } else {
    const r = await resolveRunId(parsed.runId);
    if (r) resolved = { repo: r.repo, runId: parsed.runId, run: r.run };
  }

  if (!resolved) {
    showNotification({
      title: 'Watch run',
      body: parsed.kind === 'raw-id'
        ? `Run ${parsed.runId} not found in any configured repo`
        : `Run ${parsed.runId} not found in ${(parsed as Extract<typeof parsed, { kind: 'with-repo' }>).repo}`,
    });
    return;
  }

  if (hasWatch(resolved.repo, resolved.runId)) {
    showNotification({
      title: 'Watch run',
      body: `Already watching ${resolved.run.name} #${resolved.run.run_number}`,
    });
    return;
  }

  if (resolved.run.status === 'completed') {
    showNotification({
      title: 'Watch run',
      body: `${resolved.run.name} #${resolved.run.run_number} already completed — not adding`,
    });
    return;
  }

  const watch: ManualWatch = {
    repo: resolved.repo,
    runId: resolved.runId,
    name: resolved.run.name,
    branch: resolved.run.head_branch,
    runNumber: resolved.run.run_number,
    addedAt: Date.now(),
  };
  addWatch(watch);
  logger.info(`Manual watch added: ${watch.repo} #${watch.runNumber} "${watch.name}" [${watch.branch}]`);
  const runUrl = `https://github.com/${watch.repo}/actions/runs/${watch.runId}`;
  showNotification({
    title: 'Watching run',
    body: `${watch.name} #${watch.runNumber} [${watch.branch}] (${watch.repo})`,
    silent: true,
  }, () => shell.openExternal(runUrl));
  updateTrayMenu();
}

interface RunEntry {
  name: string;
  runNumber: number;
  branch: string;
  runId: number;
  manual: boolean;
}

function buildMenu(): Menu {
  const paused = isPaused();

  const byRepo = new Map<string, RunEntry[]>();
  for (const [repo, runs] of _active) {
    if (runs.length === 0) continue;
    const arr = byRepo.get(repo) ?? [];
    for (const r of runs) {
      arr.push({ name: r.name, runNumber: r.run_number, branch: r.head_branch, runId: r.id, manual: false });
    }
    byRepo.set(repo, arr);
  }
  for (const w of getWatches()) {
    const arr = byRepo.get(w.repo) ?? [];
    if (arr.some(e => e.runId === w.runId)) continue;
    arr.push({ name: w.name, runNumber: w.runNumber, branch: w.branch, runId: w.runId, manual: true });
    byRepo.set(w.repo, arr);
  }

  const activeItems: Electron.MenuItemConstructorOptions[] = [];
  let totalActive = 0;
  for (const [repo, entries] of byRepo) {
    if (entries.length === 0) continue;
    totalActive += entries.length;
    activeItems.push({ label: repo, enabled: false });
    for (const e of entries) {
      const url = `https://github.com/${repo}/actions/runs/${e.runId}`;
      const submenu: Electron.MenuItemConstructorOptions[] = [
        { label: 'Open in browser', click: () => { shell.openExternal(url); } },
      ];
      if (e.manual) {
        submenu.push({
          label: 'Stop watching',
          click: () => {
            logger.info(`Manual watch removed via tray: ${repo} #${e.runNumber} "${e.name}"`);
            removeWatch(repo, e.runId);
            updateTrayMenu();
          },
        });
      }
      activeItems.push({
        label: `  ⏳ ${e.name} #${e.runNumber} [${e.branch}]`,
        submenu,
      });
    }
  }

  const headerLabel = totalActive > 0
    ? `${totalActive} run${totalActive !== 1 ? 's' : ''} in progress`
    : `Watching ${_repos.length} repo${_repos.length !== 1 ? 's' : ''}`;

  return Menu.buildFromTemplate([
    { label: headerLabel, enabled: false },
    ...(activeItems.length > 0
      ? [{ type: 'separator' as const }, ...activeItems]
      : []),
    { type: 'separator' as const },
    {
      label: 'Watch run from clipboard',
      click: () => { void watchFromClipboard(); },
    },
    { type: 'separator' as const },
    {
      label: 'Open Log',
      click: () => {
        const logPath = logger.transports.file.getFile().path;
        shell.openPath(logPath);
      },
    },
    { type: 'separator' as const },
    {
      label: paused ? 'Resume Polling' : 'Pause Polling',
      click: () => {
        if (isPaused()) {
          resumePolling();
        } else {
          pausePolling();
        }
        updateTrayMenu();
      },
    },
    { type: 'separator' as const },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

export function createTray(repos: RepoConfig[]): void {
  _repos = repos;
  const iconPath = path.join(__dirname, '..', 'assets', 'trayTemplate.png');
  tray = new Tray(iconPath);
  tray.setToolTip('GitHub CI Notify');
  tray.setContextMenu(buildMenu());
}

export function updateTrayMenu(active?: ActiveRuns): void {
  if (active) _active = active;
  tray?.setContextMenu(buildMenu());
}
