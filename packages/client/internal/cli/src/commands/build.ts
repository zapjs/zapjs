import { execSync } from 'child_process';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { join, resolve } from 'path';
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'fs';

export interface BuildOptions {
  release?: boolean;
  output?: string;
  target?: string;
  skipFrontend?: boolean;
  skipCodegen?: boolean;
}

interface BuildManifest {
  version: string;
  buildTime: string;
  rustBinary: string;
  staticDir: string | null;
  env: string;
}

/**
 * Build for production
 */
export async function buildCommand(options: BuildOptions): Promise<void> {
  const spinner = ora();
  const outputDir = resolve(options.output || './dist');
  const startTime = Date.now();

  try {
    console.log(chalk.cyan('\n⚡ ZapRS Production Build\n'));

    // Clean output directory
    if (existsSync(outputDir)) {
      spinner.start('Cleaning output directory...');
      rmSync(outputDir, { recursive: true, force: true });
      spinner.succeed('Output directory cleaned');
    }

    // Create output structure
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(join(outputDir, 'bin'), { recursive: true });

    // Step 1: Build Rust binary
    await buildRust(spinner, outputDir, options);

    // Step 2: Build frontend (if not skipped)
    let staticDir: string | null = null;
    if (!options.skipFrontend) {
      staticDir = await buildFrontend(spinner, outputDir);
    }

    // Step 3: Generate TypeScript bindings
    if (!options.skipCodegen) {
      await runCodegen(spinner);
    }

    // Step 4: Create production config
    await createProductionConfig(outputDir, staticDir);

    // Step 5: Create build manifest
    const manifest = createBuildManifest(outputDir, staticDir);
    writeFileSync(
      join(outputDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const binSize = getBinarySize(join(outputDir, 'bin', 'zap'));

    console.log(chalk.green(`\n✓ Build complete in ${elapsed}s\n`));
    console.log(chalk.white('  Output:'));
    console.log(chalk.gray(`    Directory: ${outputDir}`));
    console.log(chalk.gray(`    Binary:    ${binSize}`));
    if (staticDir) {
      console.log(chalk.gray(`    Static:    ${join(outputDir, 'static')}`));
    }
    console.log();
    console.log(chalk.white('  Run in production:'));
    console.log(chalk.cyan(`    cd ${outputDir} && ./bin/zap\n`));

  } catch (error) {
    spinner.fail('Build failed');
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
    }
    process.exit(1);
  }
}

async function buildRust(
  spinner: Ora,
  outputDir: string,
  options: BuildOptions
): Promise<void> {
  spinner.start('Building Rust backend (release mode)...');

  const args = ['build', '--release', '--bin', 'zap'];

  if (options.target) {
    args.push('--target', options.target);
  }

  try {
    execSync(`cargo ${args.join(' ')}`, {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    const targetDir = options.target
      ? join('target', options.target, 'release')
      : join('target', 'release');

    const srcBinary = join(process.cwd(), targetDir, 'zap');
    const destBinary = join(outputDir, 'bin', 'zap');

    if (existsSync(srcBinary)) {
      copyFileSync(srcBinary, destBinary);
      execSync(`chmod +x "${destBinary}"`, { stdio: 'pipe' });
    } else {
      throw new Error(`Binary not found at ${srcBinary}`);
    }

    spinner.succeed('Rust backend built (release + LTO)');
  } catch (error) {
    spinner.fail('Rust build failed');
    throw error;
  }
}

async function buildFrontend(
  spinner: Ora,
  outputDir: string
): Promise<string | null> {
  const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']
    .find(f => existsSync(join(process.cwd(), f)));

  if (!viteConfig) {
    spinner.info('No Vite config found, skipping frontend build');
    return null;
  }

  spinner.start('Building frontend (Vite)...');

  try {
    execSync('npx vite build', {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    const viteDist = join(process.cwd(), 'dist');
    const staticDir = join(outputDir, 'static');

    if (existsSync(viteDist)) {
      copyDirectory(viteDist, staticDir);
      spinner.succeed('Frontend built and bundled');
      return staticDir;
    } else {
      spinner.warn('Vite build completed but no output found');
      return null;
    }
  } catch {
    spinner.warn('Frontend build failed (continuing without frontend)');
    return null;
  }
}

async function runCodegen(spinner: Ora): Promise<void> {
  spinner.start('Generating TypeScript bindings...');

  const codegenPaths = [
    join(process.cwd(), 'target/release/zap-codegen'),
    'zap-codegen',
  ];

  for (const codegenPath of codegenPaths) {
    try {
      execSync(`${codegenPath} --output ./src/api`, {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
      spinner.succeed('TypeScript bindings generated');
      return;
    } catch {
      continue;
    }
  }

  spinner.info('Codegen skipped (binary not found)');
}

async function createProductionConfig(
  outputDir: string,
  staticDir: string | null
): Promise<void> {
  const config = {
    server: {
      host: '0.0.0.0',
      port: 3000,
    },
    static: staticDir ? {
      prefix: '/',
      directory: './static',
    } : null,
    logging: {
      level: 'info',
      format: 'json',
    },
  };

  writeFileSync(
    join(outputDir, 'config.json'),
    JSON.stringify(config, null, 2)
  );
}

function createBuildManifest(
  outputDir: string,
  staticDir: string | null
): BuildManifest {
  return {
    version: '1.0.0',
    buildTime: new Date().toISOString(),
    rustBinary: './bin/zap',
    staticDir: staticDir ? './static' : null,
    env: 'production',
  };
}

function copyDirectory(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function getBinarySize(path: string): string {
  try {
    const stats = statSync(path);
    const bytes = stats.size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return 'unknown';
  }
}
