import { Tray, Menu, app } from 'electron';
import * as path from 'path';
import { pausePolling, resumePolling, isPaused, ActiveRuns } from './poller';
import { RepoConfig } from './config';

let tray: Tray | null = null;
let _repos: RepoConfig[] = [];
let _active: ActiveRuns = new Map();

function buildMenu(): Menu {
  const paused = isPaused();

  // Build in-progress section
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

  return Menu.buildFromTemplate([
    { label: headerLabel, enabled: false },
    ...(activeItems.length > 0
      ? [{ type: 'separator' as const }, ...activeItems]
      : []),
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
