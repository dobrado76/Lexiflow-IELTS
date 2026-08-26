/**
 * Dev launcher: wait for Vite, then start Electron and keep this process
 * alive until the app quits. Using spawn(require('electron')) avoids the
 * Windows issue where `electron .` via npm scripts exits immediately and
 * concurrently -k then kills the Vite server.
 */
const { spawn } = require('child_process');
const waitOn = require('wait-on');
const electronPath = require('electron');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:3000';
const port = new URL(DEV_URL).port || '3000';
const host = new URL(DEV_URL).hostname || '127.0.0.1';

(async () => {
  try {
    await waitOn({
      resources: [`tcp:${host}:${port}`],
      timeout: 60_000,
      interval: 250,
    });
  } catch (err) {
    console.error(`[electron:dev] Timed out waiting for ${DEV_URL}`);
    console.error(err.message || err);
    process.exit(1);
  }

  const child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: DEV_URL,
    },
    windowsHide: false,
  });

  const shutdown = (code = 0) => {
    if (!child.killed) child.kill();
    process.exit(code);
  };

  child.on('close', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error('[electron:dev] Failed to start Electron:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
})();
