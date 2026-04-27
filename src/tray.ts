import { Tray, Menu, app, clipboard, Notification, shell } from 'electron';
import * as path from 'path';
import logger from 'electron-log';
import { pausePolling, resumePolling, isPaused, ActiveRuns, fetchSingleRun, resolveRunId } from './poller';
import { RepoConfig } from './config';
import { parseRunInput } from './parse-input';
import { getWatches, addWatch, removeWatch, hasWatch, ManualWatch } from './manual-watch';

let tray: Tray | null = null;
let _repos: RepoConfig[] = [];
let _active: ActiveRuns = new Map();

async function watchFromClipboard(): Promise<void> {
  const text = clipboard.readText();
  const parsed = parseRunInput(text);
  if (!parsed) {
    new Notification({
      title: 'Watch run',
      body: 'Clipboard does not contain a run URL or numeric run ID',
    }).show();
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
    new Notification({
      title: 'Watch run',
      body: parsed.kind === 'raw-id'
        ? `Run ${parsed.runId} not found in any configured repo`
        : `Run ${parsed.runId} not found in ${(parsed as Extract<typeof parsed, { kind: 'with-repo' }>).repo}`,
    }).show();
    return;
  }

  if (hasWatch(resolved.repo, resolved.runId)) {
    new Notification({
      title: 'Watch run',
      body: `Already watching ${resolved.run.name} #${resolved.run.run_number}`,
    }).show();
    return;
  }

  if (resolved.run.status === 'completed') {
    new Notification({
      title: 'Watch run',
      body: `${resolved.run.name} #${resolved.run.run_number} already completed — not adding`,
    }).show();
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
  new Notification({
    title: 'Watching run',
    body: `${watch.name} #${watch.runNumber} [${watch.branch}] (${watch.repo})`,
  }).show();
  updateTrayMenu();
}

function buildMenu(): Menu {
  const paused = isPaused();

  const activeItems: Electron.MenuItemConstructorOptions[] = [];
  let totalActive = 0;

  for (const [repo, runs] of _active) {
    if (runs.length === 0) continue;
    totalActive += runs.length;
    activeItems.push({ label: repo, enabled: false });
    for (const run of runs) {
      activeItems.push({
        label: `  ⏳ ${run.name} #${run.run_number} [${run.head_branch}]`,
        enabled: false,
      });
    }
  }

  const headerLabel = totalActive > 0
    ? `${totalActive} run${totalActive !== 1 ? 's' : ''} in progress`
    : `Watching ${_repos.length} repo${_repos.length !== 1 ? 's' : ''}`;

  const watches = getWatches();
  const watchItems: Electron.MenuItemConstructorOptions[] = watches.length > 0
    ? [
        { type: 'separator' },
        { label: `Manually watching (${watches.length})`, enabled: false },
        ...watches.map<Electron.MenuItemConstructorOptions>(w => ({
          label: `  ${w.name} #${w.runNumber} [${w.branch}] — ${w.repo}`,
          submenu: [
            {
              label: 'Open in browser',
              click: () => {
                shell.openExternal(`https://github.com/${w.repo}/actions/runs/${w.runId}`);
              },
            },
            {
              label: 'Stop watching',
              click: () => {
                removeWatch(w.repo, w.runId);
                updateTrayMenu();
              },
            },
          ],
        })),
      ]
    : [];

  return Menu.buildFromTemplate([
    { label: headerLabel, enabled: false },
    ...(activeItems.length > 0
      ? [{ type: 'separator' as const }, ...activeItems]
      : []),
    ...watchItems,
    { type: 'separator' as const },
    {
      label: 'Watch run from clipboard',
      click: () => { void watchFromClipboard(); },
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
