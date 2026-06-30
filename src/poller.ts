import logger from 'electron-log';
import { RepoConfig } from './config';
import { getSeenIds, markSeen } from './store';
import { notify, notifyBatch, notifyStarted, showNotification, WorkflowRun } from './notifier';
import { getWatches, removeWatch } from './manual-watch';

export type ActiveRuns = Map<string, WorkflowRun[]>; // repo → in-progress runs

interface PollState {
  paused: boolean;
  myLogin: string;
  myEmails: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

const state: PollState = {
  paused: false,
  myLogin: '',
  myEmails: [],
  timer: null,
};

let _token = '';
let _repos: RepoConfig[] = [];
let _intervalMs = 45_000;
let _globalMyEmail: boolean | undefined = undefined;
let _globalEmails: string[] | undefined = undefined;
let _onUpdate: ((active: ActiveRuns) => void) = () => {};

const activeRuns: ActiveRuns = new Map();
const initializedRepos = new Set<string>();
const notifiedStarted = new Map<string, Set<number>>(); // repo → set of run ids already notified

export interface RecentRun {
  run: WorkflowRun;
  completedAt: number;
}
const RECENT_RETENTION_MS = 15 * 60 * 1000;
const recentlyCompleted = new Map<string, RecentRun[]>();

function pushRecent(repo: string, run: WorkflowRun): void {
  const list = recentlyCompleted.get(repo) ?? [];
  list.push({ run, completedAt: Date.now() });
  recentlyCompleted.set(repo, list);
}

function pruneRecent(): void {
  const cutoff = Date.now() - RECENT_RETENTION_MS;
  for (const [repo, list] of recentlyCompleted) {
    const kept = list.filter(e => e.completedAt > cutoff);
    if (kept.length === 0) recentlyCompleted.delete(repo);
    else if (kept.length !== list.length) recentlyCompleted.set(repo, kept);
  }
}

export function getRecentlyCompleted(): Map<string, RecentRun[]> {
  return new Map(recentlyCompleted);
}

const log = (msg: string) => logger.info(msg);

let rateLimitBlockedUntil = 0; // epoch ms; 0 = not blocked

// Auth-failure tolerance: a single 401/403 is often transient (GitHub blips,
// abuse-detection 403s, brief token rejections). Only stop the poller after
// AUTH_FAILURE_LIMIT *consecutive ticks* in which auth failed and nothing
// succeeded — any successful fetch in a tick resets the counter.
const AUTH_FAILURE_LIMIT = 4;
let authFailureTicks = 0;
let tickAuthFailed = false; // any 401/403 (non-rate-limit) seen this tick
let tickAuthOk = false; // any successful fetch seen this tick

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

async function fetchMyEmails(): Promise<string[]> {
  // Try /user/emails (needs user:email scope), fall back to /user.email
  try {
    const res = await fetch('https://api.github.com/user/emails', { headers: githubHeaders() });
    if (res.ok) {
      const data = (await res.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const emails = data.filter(e => e.verified).map(e => e.email.toLowerCase());
      log(`Fetched ${emails.length} verified email(s) from /user/emails`);
      return emails;
    }
    log(`/user/emails returned ${res.status} — falling back to /user.email`);
  } catch (err) {
    log(`/user/emails fetch failed: ${String(err)} — falling back to /user.email`);
  }
  try {
    const res = await fetch('https://api.github.com/user', { headers: githubHeaders() });
    if (res.ok) {
      const data = (await res.json()) as { email: string | null };
      if (data.email) {
        log(`Using public email from /user: ${data.email}`);
        return [data.email.toLowerCase()];
      }
    }
  } catch (err) {
    log(`/user fallback email fetch failed: ${String(err)}`);
  }
  log('No emails fetched — myEmail filter will match nothing');
  return [];
}

const MAX_SHAS_PER_REPO = 100;
const trackedShas = new Map<string, string[]>(); // repo → recent "sha|branch" tuples matching allowed authors (LRU-ish)
const myBranches = new Map<string, Set<string>>(); // repo → branches that have had an authored-by-me run

function shaKey(sha: string, branch: string): string {
  return `${sha}|${branch}`;
}

function rememberSha(repo: string, sha: string, branch: string): void {
  if (!sha || !branch) return;
  const key = shaKey(sha, branch);
  const list = trackedShas.get(repo) ?? [];
  const idx = list.indexOf(key);
  if (idx !== -1) list.splice(idx, 1);
  list.push(key);
  if (list.length > MAX_SHAS_PER_REPO) list.shift();
  trackedShas.set(repo, list);
}

function rememberBranch(repo: string, branch: string): void {
  if (!branch) return;
  const set = myBranches.get(repo) ?? new Set<string>();
  set.add(branch);
  myBranches.set(repo, set);
}

function allowedEmails(rc: RepoConfig): string[] {
  const useMyEmail = rc.myEmail ?? _globalMyEmail ?? true;
  const extras = rc.emails ?? _globalEmails ?? [];
  const list: string[] = [];
  if (useMyEmail) list.push(...state.myEmails);
  list.push(...extras);
  return list.map(e => e.toLowerCase());
}

function runAuthoredByEmail(run: WorkflowRun, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  const author = run.head_commit?.author?.email?.toLowerCase();
  const committer = run.head_commit?.committer?.email?.toLowerCase();
  if (author && allowed.includes(author)) return true;
  if (committer && allowed.includes(committer)) return true;
  return false;
}

function applyFilters(runs: WorkflowRun[], repoConfig: RepoConfig): WorkflowRun[] {
  const { repo, workflows } = repoConfig;
  const allowed = allowedEmails(repoConfig);

  // First pass: index branches + SHA+branch tuples for runs authored by me/allowed
  for (const run of runs) {
    if (runAuthoredByEmail(run, allowed)) {
      rememberBranch(repo, run.head_branch);
      rememberSha(repo, run.head_sha, run.head_branch);
    }
  }
  const knownBranches = myBranches.get(repo) ?? new Set<string>();
  const knownKeys = new Set(trackedShas.get(repo) ?? []);

  return runs.filter(run => {
    if (workflows?.length) {
      if (!workflows.some(w => w.toLowerCase() === run.name.toLowerCase())) return false;
    }
    if (runAuthoredByEmail(run, allowed)) return true;
    if (run.head_branch && knownBranches.has(run.head_branch)) return true;
    if (run.head_sha && run.head_branch && knownKeys.has(shaKey(run.head_sha, run.head_branch))) return true;
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
    tickAuthFailed = true;
    log(`Auth failed for ${repo} (401) — will retry next tick`);
    return null;
  }

  if (res.status === 403) {
    const remaining = res.headers.get('X-RateLimit-Remaining');
    if (remaining === '0') {
      applyRateLimitBlock(res, '403 primary');
      return null;
    }
    tickAuthFailed = true;
    log(`Auth failed for ${repo} (403) — will retry next tick`);
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

  tickAuthOk = true;
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
      pushRecent(repo, run);
      notify(repo, run);
    } else if (notifiable.length > 1) {
      log(`  notify batch: ${notifiable.map(r => `"${r.name}" ${r.conclusion}`).join(', ')}`);
      for (const r of notifiable) pushRecent(repo, r);
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
      pushRecent(w.repo, run);
      notify(w.repo, run);
      removeWatch(w.repo, w.runId);
    }
  }
}

// Decide whether the poller should keep running based on this tick's auth
// outcomes. Any success clears the streak (and notifies on recovery); a tick
// with only auth failures advances the streak and stops once it's sustained.
function evaluateAuthHealth(): void {
  if (tickAuthOk) {
    if (authFailureTicks > 0) {
      log(`Auth recovered after ${authFailureTicks} failed tick(s)`);
      showNotification({
        title: 'GitHub CI Notify — Connected',
        body: 'Authentication recovered',
      });
    }
    authFailureTicks = 0;
    return;
  }
  if (!tickAuthFailed) return; // no auth signal either way (e.g. rate-limited)

  authFailureTicks++;
  if (authFailureTicks < AUTH_FAILURE_LIMIT) {
    log(`Auth failing — tick ${authFailureTicks}/${AUTH_FAILURE_LIMIT}, will retry`);
    return;
  }
  log(`Auth failed ${authFailureTicks} consecutive ticks — stopping poller`);
  showNotification({
    title: 'GitHub CI Notify — Auth Failed',
    body: 'Check token in config.json — polling stopped',
  });
  stopPolling();
}

async function tick(): Promise<void> {
  if (state.paused) return;

  tickAuthFailed = false;
  tickAuthOk = false;
  try {
    await Promise.allSettled(_repos.map(pollRepo));
    await pollManualWatches();
  } catch (err) {
    log(`Tick error: ${String(err)}`);
  }
  evaluateAuthHealth();
  pruneRecent();
  _onUpdate(new Map(activeRuns));

  if (!state.paused) {
    state.timer = setTimeout(() => void tick(), _intervalMs);
  }
}

export async function startPolling(
  token: string,
  repos: RepoConfig[],
  intervalSeconds: number,
  onUpdate: (active: ActiveRuns) => void,
  globals?: { myEmail?: boolean; emails?: string[] }
): Promise<void> {
  _token = token;
  _repos = repos;
  _intervalMs = intervalSeconds * 1000;
  _globalMyEmail = globals?.myEmail;
  _globalEmails = globals?.emails;
  _onUpdate = onUpdate;

  state.myLogin = await fetchMyLogin();
  state.myEmails = await fetchMyEmails();
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
  authFailureTicks = 0;
  state.paused = false;
  state.timer = setTimeout(() => void tick(), 0);
}

export function isPaused(): boolean {
  return state.paused;
}
