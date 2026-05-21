import { Notification, shell } from 'electron';
import { exec } from 'child_process';

const SOUNDS = {
  success: '/System/Library/Sounds/Glass.aiff',
  failure: '/System/Library/Sounds/Basso.aiff',
  started: '/System/Library/Sounds/Submarine.aiff',
};

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_number: number;
  html_url: string;
  head_branch: string;
  head_sha: string;
  actor: { login: string };
  triggering_actor?: { login: string };
  head_commit?: {
    author?: { name: string; email: string };
    committer?: { name: string; email: string };
  };
}

const liveNotifications = new Set<Notification>();

export function showNotification(opts: Electron.NotificationConstructorOptions, onClick?: () => void): void {
  const n = new Notification(opts);
  liveNotifications.add(n);
  if (onClick) n.on('click', onClick);
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

export function notify(repo: string, run: WorkflowRun): void {
  const success = run.conclusion === 'success';
  const repoName = repo.split('/')[1] ?? repo;
  const title = `${success ? '✓' : '✗'} ${repoName}`;
  const body = `${run.name} ${success ? 'passed' : 'FAILED'} (#${run.run_number}) [${run.head_branch}]`;
  showNotification({ title, body, silent: true }, () => shell.openExternal(run.html_url));
  playSound(run.conclusion ?? 'failure');
}

export function notifyBatch(repo: string, runs: WorkflowRun[]): void {
  const passed = runs.filter(r => r.conclusion === 'success').length;
  const failed = runs.length - passed;
  const repoName = repo.split('/')[1] ?? repo;

  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);

  showNotification({
    title: `GitHub CI: ${repoName}`,
    body: `${runs.length} runs completed — ${parts.join(', ')}`,
    silent: true,
  });
  playSound(failed > 0 ? 'failure' : 'success');
}

function playSound(conclusion: string): void {
  const sound = conclusion === 'success' ? SOUNDS.success : SOUNDS.failure;
  exec(`afplay "${sound}"`);
}

export function notifyStarted(repo: string, runs: WorkflowRun[]): void {
  const repoName = repo.split('/')[1] ?? repo;

  if (runs.length === 1) {
    const run = runs[0];
    showNotification({
      title: `▶ ${repoName}`,
      body: `${run.name} started (#${run.run_number}) [${run.head_branch}]`,
      silent: true,
    }, () => shell.openExternal(run.html_url));
  } else {
    showNotification({
      title: `▶ ${repoName}`,
      body: `${runs.length} runs started — ${runs.map(r => r.name).join(', ')}`,
      silent: true,
    });
  }

  exec(`afplay "${SOUNDS.started}"`);
}
