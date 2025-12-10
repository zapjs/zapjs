import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { findAvailablePort } from '../utils/port-finder.js';

export interface ServeOptions {
  port?: string;
  host?: string;
  config?: string;
  workers?: string;
}

interface ProductionConfig {
  server: {
    host: string;
    port: number;
  };
  static?: {
    prefix: string;
    directory: string;
  } | null;
  logging?: {
    level: string;
    format: string;
  };
}

/**
 * Run production server
 */
export async function serveCommand(options: ServeOptions): Promise<void> {
  const spinner = ora();

  try {
    console.log(chalk.cyan('\n⚡ ZapRS Production Server\n'));

    // Determine working directory (dist or current)
    const distDir = resolve('./dist');
    const workDir = existsSync(join(distDir, 'bin', 'zap')) ? distDir : process.cwd();
    const binPath = join(workDir, 'bin', 'zap');

    // Check for binary
    if (!existsSync(binPath)) {
      const altPath = join(process.cwd(), 'target', 'release', 'zap');
      if (existsSync(altPath)) {
        await runServer(altPath, options, spinner, process.cwd());
      } else {
        console.error(chalk.red('\nError: No production binary found.'));
        console.error(chalk.gray('Run `zap build` first to create a production build.\n'));
        process.exit(1);
      }
      return;
    }

    // Load config if available
    let config: ProductionConfig | null = null;
    const configPath = options.config || join(workDir, 'config.json');
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
        spinner.succeed(`Loaded config from ${configPath}`);
      } catch {
        spinner.warn('Failed to parse config.json, using defaults');
      }
    }

    await runServer(binPath, options, spinner, workDir, config);

  } catch (error) {
    spinner.fail('Failed to start server');
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
    }
    process.exit(1);
  }
}

async function runServer(
  binPath: string,
  options: ServeOptions,
  spinner: Ora,
  workDir: string,
  config?: ProductionConfig | null
): Promise<void> {
  const port = parseInt(options.port || config?.server?.port?.toString() || '3000');
  const host = options.host || config?.server?.host || '0.0.0.0';

  // Find available port
  spinner.start(`Checking port ${port}...`);
  const availablePort = await findAvailablePort(port);

  if (availablePort !== port) {
    spinner.warn(`Port ${port} in use, using ${availablePort}`);
  } else {
    spinner.succeed(`Port ${availablePort} available`);
  }

  // Start server
  spinner.start('Starting production server...');

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: availablePort.toString(),
    HOST: host,
    RUST_LOG: 'info',
    ZAP_ENV: 'production',
  };

  if (options.workers) {
    env.ZAP_WORKERS = options.workers;
  }

  const proc: ChildProcess = spawn(binPath, [], {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let started = false;

  proc.stdout?.on('data', (data: Buffer) => {
    const output = data.toString();
    if (!started && output.includes('listening')) {
      started = true;
      spinner.succeed('Server started');
      printServerInfo(host, availablePort, workDir, config);
    }
    if (started) {
      process.stdout.write(chalk.gray(output));
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const output = data.toString();
    if (!started) {
      spinner.fail('Server failed to start');
      console.error(chalk.red(output));
      process.exit(1);
    }
    process.stderr.write(chalk.red(output));
  });

  proc.on('error', (err: Error) => {
    spinner.fail(`Failed to start: ${err.message}`);
    process.exit(1);
  });

  proc.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.error(chalk.red(`\nServer exited with code ${code}\n`));
      process.exit(code);
    }
  });

  // If server doesn't output "listening", assume it started after a delay
  setTimeout(() => {
    if (!started) {
      started = true;
      spinner.succeed('Server started');
      printServerInfo(host, availablePort, workDir, config);
    }
  }, 2000);

  // Graceful shutdown
  const shutdown = () => {
    console.log(chalk.yellow('\n\nShutting down...'));
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
      process.exit(0);
    }, 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printServerInfo(
  host: string,
  port: number,
  workDir: string,
  config?: ProductionConfig | null
): void {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;

  console.log(chalk.green('\n✓ Production server running\n'));
  console.log(chalk.white('  Endpoints:'));
  console.log(chalk.cyan(`    ➜ http://${displayHost}:${port}`));

  if (host === '0.0.0.0') {
    console.log(chalk.gray(`    ➜ http://0.0.0.0:${port} (all interfaces)`));
  }

  if (config?.static) {
    console.log(chalk.gray(`\n  Static files: ${config.static.directory}`));
  }

  console.log(chalk.gray(`\n  Working dir: ${workDir}`));
  console.log(chalk.gray('\n  Press Ctrl+C to stop\n'));
}
