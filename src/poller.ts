import { Notification } from 'electron';
import logger from 'electron-log';
import { RepoConfig } from './config';
import { getSeenIds, markSeen } from './store';
import { notify, notifyBatch, WorkflowRun } from './notifier';

export type ActiveRuns = Map<string, WorkflowRun[]>; // repo → in-progress runs

interface PollState {
  paused: boolean;
  myLogin: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const state: PollState = {
  paused: false,
  myLogin: '',
  timer: null,
};

let _token = '';
let _repos: RepoConfig[] = [];
let _intervalMs = 45_000;
let _onUpdate: ((active: ActiveRuns) => void) = () => {};

const activeRuns: ActiveRuns = new Map();
const initializedRepos = new Set<string>();

const log = (msg: string) => logger.info(msg);

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${_token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-ci-notify',
  };
}

async function githubFetch(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { headers: githubHeaders() });
  } catch (err) {
    log(`Network error: ${String(err)}`);
    return null;
  }
}

async function fetchMyLogin(): Promise<string> {
  const res = await fetch('https://api.github.com/user', { headers: githubHeaders() });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`GitHub auth failed (${res.status}). Check token in config.json.`);
  }
  const data = (await res.json()) as { login: string };
  log(`Authenticated as ${data.login}`);
  return data.login;
}

function applyFilters(runs: WorkflowRun[], repoConfig: RepoConfig): WorkflowRun[] {
  const { workflows, filterCurrentUser = true } = repoConfig;
  return runs.filter(run => {
    if (filterCurrentUser && run.actor.login !== state.myLogin) return false;
    if (workflows?.length) {
      if (!workflows.some(w => w.toLowerCase() === run.name.toLowerCase())) return false;
    }
    return true;
  });
}

async function fetchRuns(
  repo: string,
  status: 'in_progress' | 'completed',
  actorFilter?: string
): Promise<WorkflowRun[] | null> {
  const actor = actorFilter ? `&actor=${encodeURIComponent(actorFilter)}` : '';
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/actions/runs?status=${status}&per_page=30${actor}`
  );
  if (!res) return null;

  if (res.status === 401 || res.status === 403) {
    log(`Auth failed for ${repo} (${res.status}) — stopping poller`);
    new Notification({
      title: 'GitHub CI Notify — Auth Failed',
      body: `Check token in config.json (repo: ${repo})`,
    }).show();
    stopPolling();
    return null;
  }

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
    log(`Rate limited on ${repo} — backing off ${retryAfter}s`);
    await new Promise<void>(r => setTimeout(r, retryAfter * 1000));
    return null;
  }

  if (!res.ok) {
    log(`Unexpected response for ${repo}: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
  return data.workflow_runs;
}

async function pollRepo(repoConfig: RepoConfig): Promise<void> {
  const { repo, filterCurrentUser = true } = repoConfig;
  const actorFilter = filterCurrentUser ? state.myLogin : undefined;
  log(`Polling ${repo}...`);

  // Fetch in-progress runs for tray display
  const inProgressRuns = await fetchRuns(repo, 'in_progress', actorFilter);
  if (inProgressRuns) {
    const filtered = applyFilters(inProgressRuns, repoConfig);
    activeRuns.set(repo, filtered);
    if (filtered.length > 0) {
      log(`${repo}: ${filtered.length} run(s) in progress — ${filtered.map(r => `"${r.name}" [${r.head_branch}]`).join(', ')}`);
    }
  }

  // Fetch completed runs for notifications
  const completedRuns = await fetchRuns(repo, 'completed', actorFilter);
  if (completedRuns) {
    const allCompletedIds = completedRuns.map(r => r.id);
    const seenIds = getSeenIds(repo);
    const newRuns = completedRuns.filter(r => !seenIds.has(r.id));

    if (newRuns.length > 0) {
      log(`${repo}: ${newRuns.length} new completed run(s) detected`);
    }

    const notifiable = applyFilters(newRuns, repoConfig);
    const skipped = newRuns.length - notifiable.length;
    if (skipped > 0) {
      log(`  ${skipped} run(s) skipped by actor/workflow filter`);
    }

    markSeen(repo, allCompletedIds);

    const isFirstPoll = !initializedRepos.has(repo);
    initializedRepos.add(repo);

    if (isFirstPoll) {
      if (notifiable.length > 0) {
        log(`${repo}: ${notifiable.length} run(s) on startup — suppressed (stale)`);
      }
    } else if (notifiable.length === 1) {
      const run = notifiable[0];
      log(`  notify #${run.run_number} "${run.name}" [${run.head_branch}] — ${run.conclusion}`);
      notify(repo, run);
    } else if (notifiable.length > 1) {
      log(`  notify batch: ${notifiable.map(r => `"${r.name}" ${r.conclusion}`).join(', ')}`);
      notifyBatch(repo, notifiable);
    }
  }
}

async function tick(): Promise<void> {
  if (state.paused) return;

  await Promise.allSettled(_repos.map(pollRepo));
  _onUpdate(new Map(activeRuns));

  if (!state.paused) {
    state.timer = setTimeout(() => void tick(), _intervalMs);
  }
}

export async function startPolling(
  token: string,
  repos: RepoConfig[],
  intervalSeconds: number,
  onUpdate: (active: ActiveRuns) => void
): Promise<void> {
  _token = token;
  _repos = repos;
  _intervalMs = intervalSeconds * 1000;
  _onUpdate = onUpdate;

  state.myLogin = await fetchMyLogin();
  log(`Polling ${repos.length} repo(s) every ${intervalSeconds}s`);
  state.timer = setTimeout(() => void tick(), 0);
}

export function stopPolling(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.paused = true;
}

export function pausePolling(): void {
  log('Polling paused');
  state.paused = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

export function resumePolling(): void {
  log('Polling resumed');
  state.paused = false;
  state.timer = setTimeout(() => void tick(), 0);
}

export function isPaused(): boolean {
  return state.paused;
}
