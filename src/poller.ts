import logger from 'electron-log';
import { RepoConfig } from './config';
import { getSeenIds, markSeen } from './store';
import { notify, notifyBatch, notifyStarted, showNotification, WorkflowRun } from './notifier';
import { getWatches, removeWatch } from './manual-watch';

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
const notifiedStarted = new Map<string, Set<number>>(); // repo → set of run ids already notified

const log = (msg: string) => logger.info(msg);

let rateLimitBlockedUntil = 0; // epoch ms; 0 = not blocked

function backoffMsFromHeaders(res: Response): number {
  const reset = res.headers.get('X-RateLimit-Reset');
  if (reset) {
    const waitMs = parseInt(reset, 10) * 1000 - Date.now();
    if (waitMs > 0) return waitMs;
  }
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter) return parseInt(retryAfter, 10) * 1000;
  return 60_000;
}

function applyRateLimitBlock(res: Response, label: string): void {
  const backoffMs = backoffMsFromHeaders(res);
  rateLimitBlockedUntil = Date.now() + backoffMs;
  log(`Rate limited (${label}) — blocking for ${Math.ceil(backoffMs / 1000)}s`);
}

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${_token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-ci-notify',
  };
}

async function githubFetch(url: string): Promise<Response | null> {
  const now = Date.now();
  if (rateLimitBlockedUntil > now) {
    log(`Rate limit backoff — skipping fetch ${url} (${Math.ceil((rateLimitBlockedUntil - now) / 1000)}s left)`);
    return null;
  }
  try {
    const res = await fetch(url, { headers: githubHeaders() });
    const remaining = res.headers.get('X-RateLimit-Remaining');
    if (remaining !== null && parseInt(remaining, 10) === 0) {
      applyRateLimitBlock(res, 'exhausted');
    }
    return res;
  } catch (err) {
    log(`Network error fetching ${url}: ${String(err)}`);
    return null;
  }
}

async function fetchMyLogin(): Promise<string> {
  const delaysMs = [5_000, 15_000, 30_000, 60_000];
  let attempt = 0;
  let hadFailure = false;
  for (;;) {
    try {
      const res = await fetch('https://api.github.com/user', { headers: githubHeaders() });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`GitHub auth failed (${res.status}). Check token in Keychain or config.json.`);
      }
      if (!res.ok) {
        throw new Error(`Unexpected status ${res.status} from /user`);
      }
      const data = (await res.json()) as { login: string };
      log(`Authenticated as ${data.login}`);
      if (hadFailure) {
        showNotification({
          title: 'GitHub CI Notify — Connected',
          body: `Authenticated as ${data.login}`,
        });
      }
      return data.login;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('GitHub auth failed')) {
        throw err;
      }
      hadFailure = true;
      const wait = delaysMs[Math.min(attempt, delaysMs.length - 1)];
      log(`Login fetch failed (${String(err)}) — retrying in ${wait / 1000}s`);
      await new Promise<void>(r => setTimeout(r, wait));
      attempt++;
    }
  }
}

const MAX_SHAS_PER_REPO = 100;
const myShas = new Map<string, string[]>(); // repo → recent head_shas user actored (LRU-ish)

function rememberSha(repo: string, sha: string): void {
  if (!sha) return;
  const list = myShas.get(repo) ?? [];
  const idx = list.indexOf(sha);
  if (idx !== -1) list.splice(idx, 1);
  list.push(sha);
  if (list.length > MAX_SHAS_PER_REPO) list.shift();
  myShas.set(repo, list);
}

function isMine(run: WorkflowRun): boolean {
  return run.actor.login === state.myLogin || run.triggering_actor?.login === state.myLogin;
}

function applyFilters(runs: WorkflowRun[], repoConfig: RepoConfig): WorkflowRun[] {
  const { repo, workflows, filterCurrentUser = true } = repoConfig;

  // First pass: index SHAs of user-actored runs (regardless of workflow filter)
  for (const run of runs) {
    if (isMine(run)) rememberSha(repo, run.head_sha);
  }

  const knownShas = new Set(myShas.get(repo) ?? []);

  return runs.filter(run => {
    if (workflows?.length) {
      if (!workflows.some(w => w.toLowerCase() === run.name.toLowerCase())) return false;
    }
    if (!filterCurrentUser) return true;
    if (isMine(run)) return true;
    if (run.head_sha && knownShas.has(run.head_sha)) return true;
    return false;
  });
}

async function fetchRuns(
  repo: string,
  status: 'in_progress' | 'completed'
): Promise<WorkflowRun[] | null> {
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/actions/runs?status=${status}&per_page=30`
  );
  if (!res) return null;

  if (res.status === 401) {
    log(`Auth failed for ${repo} (401) — stopping poller`);
    showNotification({
      title: 'GitHub CI Notify — Auth Failed',
      body: `Check token in config.json (repo: ${repo})`,
    });
    stopPolling();
    return null;
  }

  if (res.status === 403) {
    const remaining = res.headers.get('X-RateLimit-Remaining');
    if (remaining === '0') {
      applyRateLimitBlock(res, '403 primary');
      return null;
    }
    log(`Auth failed for ${repo} (403) — stopping poller`);
    showNotification({
      title: 'GitHub CI Notify — Auth Failed',
      body: `Check token in config.json (repo: ${repo})`,
    });
    stopPolling();
    return null;
  }

  if (res.status === 429) {
    applyRateLimitBlock(res, '429 secondary');
    return null;
  }

  if (!res.ok) {
    let bodySnippet = '';
    try { bodySnippet = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    log(`Unexpected ${res.status} for ${repo} (status=${status}) — ${bodySnippet}`);
    return null;
  }

  try {
    const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
    return data.workflow_runs;
  } catch (err) {
    log(`Failed to parse runs JSON for ${repo}: ${String(err)}`);
    return null;
  }
}

async function pollRepo(repoConfig: RepoConfig): Promise<void> {
  const { repo } = repoConfig;
  log(`Polling ${repo}...`);

  // Fetch in-progress runs for tray display
  const inProgressRuns = await fetchRuns(repo, 'in_progress');
  if (inProgressRuns) {
    const filtered = applyFilters(inProgressRuns, repoConfig);
    const notified = notifiedStarted.get(repo) ?? new Set<number>();
    const newlyStarted = filtered.filter(r => !notified.has(r.id));
    activeRuns.set(repo, filtered);
    if (filtered.length > 0) {
      log(`${repo}: ${filtered.length} run(s) in progress — ${filtered.map(r => `"${r.name}" [${r.head_branch}]`).join(', ')}`);
    }
    if (newlyStarted.length > 0) {
      for (const r of newlyStarted) notified.add(r.id);
      notifiedStarted.set(repo, notified);
      if (initializedRepos.has(repo)) {
        log(`  ${newlyStarted.length} newly started — ${newlyStarted.map(r => `"${r.name}"`).join(', ')}`);
        _onUpdate(new Map(activeRuns)); // refresh tray before firing notif
        notifyStarted(repo, newlyStarted);
      }
    }
  }

  // Fetch completed runs for notifications
  const completedRuns = await fetchRuns(repo, 'completed');
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

export async function fetchSingleRun(repo: string, runId: number): Promise<WorkflowRun | null> {
  const res = await githubFetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`);
  if (!res) return null;
  if (res.status === 404) return null;
  if (!res.ok) {
    let bodySnippet = '';
    try { bodySnippet = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    log(`fetchSingleRun ${repo}#${runId}: ${res.status} — ${bodySnippet}`);
    return null;
  }
  try {
    return (await res.json()) as WorkflowRun;
  } catch (err) {
    log(`Failed to parse run JSON for ${repo}#${runId}: ${String(err)}`);
    return null;
  }
}

export async function resolveRunId(runId: number): Promise<{ repo: string; run: WorkflowRun } | null> {
  const probes = _repos.map(async rc => {
    const run = await fetchSingleRun(rc.repo, runId);
    return run ? { repo: rc.repo, run } : null;
  });
  const results = await Promise.all(probes);
  return results.find((r): r is { repo: string; run: WorkflowRun } => r !== null) ?? null;
}

async function pollManualWatches(): Promise<void> {
  const watches = getWatches();
  if (watches.length === 0) return;
  for (const w of watches) {
    const run = await fetchSingleRun(w.repo, w.runId);
    if (!run) continue;
    if (run.status === 'completed') {
      log(`manual watch: ${w.repo} #${run.run_number} "${run.name}" — ${run.conclusion}`);
      notify(w.repo, run);
      removeWatch(w.repo, w.runId);
    }
  }
}

async function tick(): Promise<void> {
  if (state.paused) return;

  try {
    await Promise.allSettled(_repos.map(pollRepo));
    await pollManualWatches();
  } catch (err) {
    log(`Tick error: ${String(err)}`);
  }
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
