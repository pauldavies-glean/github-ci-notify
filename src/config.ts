import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import logger from 'electron-log';
import { getToken, setToken } from './keychain';

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

export async function loadConfig(): Promise<Config> {
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

  if (!config.repos?.length) throw new Error('config.json: "repos" must be a non-empty array');

  let token = await getToken();
  if (!token) {
    if (!config.token) {
      throw new Error(
        'No token found. Add to Keychain: security add-generic-password -s github-ci-notify -a token -w <token>\n' +
        'Or set "token" in config.json (will auto-migrate to Keychain on first run).'
      );
    }
    token = config.token;
    try {
      await setToken(token);
      logger.warn('Token migrated from config.json to Keychain. Remove "token" from config.json for security.');
    } catch (err) {
      logger.error(`Failed to write token to Keychain: ${String(err)}. Continuing with config.json token.`);
    }
  }

  return {
    token,
    pollIntervalSeconds: config.pollIntervalSeconds ?? 45,
    repos: config.repos,
  };
}
