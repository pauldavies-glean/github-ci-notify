import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from 'electron-log';

const execFileP = promisify(execFile);

const SERVICE = 'github-ci-notify';
const ACCOUNT = 'token';

export async function getToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w',
    ]);
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  await execFileP('security', [
    'add-generic-password',
    '-U',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w', token,
  ]);
  logger.info(`Token stored in macOS Keychain (service=${SERVICE}, account=${ACCOUNT})`);
}
