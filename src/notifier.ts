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
  actor: { login: string };
}

export function notify(repo: string, run: WorkflowRun): void {
  const success = run.conclusion === 'success';
  const repoName = repo.split('/')[1] ?? repo;
  const title = `${success ? '✓' : '✗'} ${repoName}`;
  const body = `${run.name} ${success ? 'passed' : 'FAILED'} (#${run.run_number}) [${run.head_branch}]`;

  const notification = new Notification({ title, body, silent: true });
  notification.on('click', () => {
    shell.openExternal(run.html_url);
  });
  notification.show();

  playSound(run.conclusion ?? 'failure');
}

export function notifyBatch(repo: string, runs: WorkflowRun[]): void {
  const passed = runs.filter(r => r.conclusion === 'success').length;
  const failed = runs.length - passed;
  const repoName = repo.split('/')[1] ?? repo;

  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);

  const notification = new Notification({
    title: `GitHub CI: ${repoName}`,
    body: `${runs.length} runs completed — ${parts.join(', ')}`,
    silent: true,
  });
  notification.show();
  playSound(failed > 0 ? 'failure' : 'success');
}

function playSound(conclusion: string): void {
  const sound = conclusion === 'success' ? SOUNDS.success : SOUNDS.failure;
  exec(`afplay "${sound}"`);
}

export function notifyStarted(): void {
  exec(`afplay "${SOUNDS.started}"`);
}
