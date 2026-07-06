const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const viteBin = path.join(root, 'node_modules', '.bin', isWindows ? 'vite.cmd' : 'vite');
const devUrl = 'http://127.0.0.1:5173';

let electronProcess;

function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    ...options
  });
  child.on('exit', (code, signal) => {
    if (child === electronProcess) {
      process.exit(code ?? (signal ? 1 : 0));
    }
  });
  return child;
}

function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(tick, 250);
      });
      req.setTimeout(1000, () => {
        req.destroy();
      });
    };
    tick();
  });
}

async function main() {
  const vite = spawnLogged(viteBin, ['--host', '127.0.0.1', '--port', '5173']);

  const cleanup = () => {
    if (electronProcess && !electronProcess.killed) electronProcess.kill();
    if (vite && !vite.killed) vite.kill();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  await waitForServer(devUrl);
  const electronPath = require('electron');
  electronProcess = spawnLogged(electronPath, ['.'], {
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devUrl
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
