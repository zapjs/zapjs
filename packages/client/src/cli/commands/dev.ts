import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import chokidar from 'chokidar';

export interface DevOptions { port?: string; host?: string; }

export async function devCommand(options: DevOptions): Promise<void> {
  const root = process.cwd();
  const port = Number(options.port || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  const host = options.host || '127.0.0.1';
  let child: ChildProcess | null = null;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restarting = Promise.resolve();
  const stopChild = async () => {
    const current = child;
    if (current?.pid && current.exitCode === null && current.signalCode === null) {
      await new Promise<void>(resolve => {
        const signal = (signal: NodeJS.Signals) => {
          try {
            if (process.platform !== 'win32' && current.pid) process.kill(-current.pid, signal);
            else current.kill(signal);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        };
        const force = setTimeout(() => signal('SIGKILL'), 3000);
        current.once('exit', () => { clearTimeout(force); resolve(); });
        signal('SIGTERM');
      });
    }
    child = null;
  };
  const launch = () => {
    if (stopping) return;
    child = spawn(process.execPath, [fileURLToPath(new URL('../../dev-server/runner.js', import.meta.url)), JSON.stringify({ root, port, host })], {
      stdio: 'inherit', cwd: root, detached: process.platform !== 'win32', env: { ...process.env, NODE_ENV: 'development' },
    });
    child.on('error', error => console.error('[zap] Failed to launch development runtime:', error));
    child.on('exit', code => {
      if (code && !stopping) console.error('[zap] Runtime stopped. Fix the error; editing application/native sources will retry.');
    });
  };
  const watcher = chokidar.watch([join(root, 'native'), join(root, 'app'), join(root, 'zap.runtime.ts'), join(root, 'zap.runtime.js')], {
    ignoreInitial: true, ignored: ['**/target/**', '**/.git/**'], awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  watcher.on('all', (_event, file) => {
    const nativeChange = file.startsWith(join(root, 'native')) && (file.endsWith('.rs') || file.endsWith('Cargo.toml') || file.endsWith('Cargo.lock'));
    const runtimeStopped = !child || child.exitCode !== null || child.signalCode !== null;
    if (!nativeChange && !runtimeStopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      restarting = restarting.then(async () => { await stopChild(); launch(); }).catch(error => console.error('[zap] Native restart failed:', error));
    }, 100);
  });
  const shutdown = async () => {
    stopping = true;
    clearTimeout(timer);
    await watcher.close();
    await restarting;
    await stopChild();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  launch();
}
