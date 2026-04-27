import { app, Notification } from 'electron';
import logger from 'electron-log';

logger.transports.file.level = 'info';
logger.transports.console.level = 'info';
logger.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}';
import { loadConfig } from './config';
import { initStore } from './store';
import { createTray, updateTrayMenu } from './tray';
import { startPolling } from './poller';

// Single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Prevent auto-quit when no windows open (tray-only app)
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  app.dock?.hide();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    new Notification({
      title: 'GitHub CI Notify — Config Error',
      body: String(err),
    }).show();
    console.error(err);
    return;
  }

  initStore();
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
