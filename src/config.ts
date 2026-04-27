import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface RepoConfig {
  repo: string;
  workflows?: string[];
  filterCurrentUser?: boolean; // default: true
}

export interface Config {
  token: string;
  pollIntervalSeconds: number;
  repos: RepoConfig[];
}

export function loadConfig(): Config {
  const configPath = app.isPackaged
    ? path.join(process.resourcesPath, 'config.json')
    : path.join(__dirname, '..', 'config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}.\nCreate config.json with your GitHub token and repos.`
    );
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as Partial<Config>;

  if (!config.token) throw new Error('config.json: "token" is required');
  if (!config.repos?.length) throw new Error('config.json: "repos" must be a non-empty array');

  return {
    token: config.token,
    pollIntervalSeconds: config.pollIntervalSeconds ?? 45,
    repos: config.repos,
  };
}
