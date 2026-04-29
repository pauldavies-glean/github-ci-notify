import { app, Notification } from 'electron';
import logger from 'electron-log';

logger.transports.file.level = 'info';
logger.transports.console.level = 'info';
logger.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}';
import { loadConfig } from './config';
import { initStore } from './store';
import { initManualWatch } from './manual-watch';
import { createTray, updateTrayMenu } from './tray';
import { startPolling } from './poller';

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.stack ?? err}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${String(reason)}`);
});

// Single instance lock
if (!app.requestSingleInstanceLock()) {
  logger.warn('Another instance already running — quitting');
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  logger.info('Second-instance launch attempt blocked by lock');
});
app.on('before-quit', () => logger.info('App quitting (before-quit)'));
app.on('will-quit', () => logger.info('App quitting (will-quit)'));
app.on('quit', (_e, code) => logger.info(`App quit (exit code=${code})`));

// Prevent auto-quit when no windows open (tray-only app)
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  logger.info('App ready — starting up');
  app.dock?.hide();

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    new Notification({
      title: 'GitHub CI Notify — Config Error',
      body: String(err),
    }).show();
    console.error(err);
    return;
  }

  initStore();
  initManualWatch();
  createTray(config.repos);

  try {
    await startPolling(config.token, config.repos, config.pollIntervalSeconds, (active) => {
      updateTrayMenu(active);
    });
  } catch (err) {
    new Notification({
      title: 'GitHub CI Notify — Startup Error',
      body: String(err),
    }).show();
    console.error(err);
  }
});
