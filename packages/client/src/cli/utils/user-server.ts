import { existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { cliLogger } from './logger.js';

/**
 * Check if project has a server/Cargo.toml (user's Rust server)
 */
export function hasUserServer(projectDir: string): boolean {
  const serverCargoToml = join(projectDir, 'server', 'Cargo.toml');
  return existsSync(serverCargoToml);
}

/**
 * Build user's Rust server in development mode
 * Returns path to built binary or null on failure
 */
export async function buildUserServer(
  projectDir: string,
  binaryName: string = 'server'
): Promise<string | null> {
  const serverDir = join(projectDir, 'server');

  if (!existsSync(join(serverDir, 'Cargo.toml'))) {
    return null;
  }

  try {
    cliLogger.spinner('user-server', 'Building Rust server...');

    execSync('cargo build --bin ' + binaryName, {
      cwd: serverDir,
      stdio: 'pipe',
    });

    // Find the built binary
    const targetDir = join(serverDir, 'target', 'debug');
    const binaryPath = join(targetDir, binaryName);

    if (existsSync(binaryPath)) {
      cliLogger.succeedSpinner('user-server', 'User server built');
      return binaryPath;
    }

    cliLogger.failSpinner('user-server', 'Binary not found after build');
    return null;
  } catch (error) {
    cliLogger.failSpinner('user-server', 'User server build failed');
    if (error instanceof Error) {
      cliLogger.error(error.message);
    }
    return null;
  }
}

/**
 * Build user's Rust server in release mode for production
 */
export async function buildUserServerRelease(
  projectDir: string,
  outputDir: string,
  binaryName: string = 'server'
): Promise<boolean> {
  const serverDir = join(projectDir, 'server');

  if (!existsSync(join(serverDir, 'Cargo.toml'))) {
    cliLogger.info('No user server found (skipping)');
    return true; // Not an error
  }

  try {
    cliLogger.spinner('user-server-release', 'Building user server (release mode)...');

    execSync('cargo build --release --bin ' + binaryName, {
      cwd: serverDir,
      stdio: 'pipe',
    });

    // Copy binary to dist/bin/
    const srcBinary = join(serverDir, 'target', 'release', binaryName);
    const destBinary = join(outputDir, 'bin', binaryName);

    if (existsSync(srcBinary)) {
      copyFileSync(srcBinary, destBinary);
      execSync(`chmod +x "${destBinary}"`, { stdio: 'pipe' });

      cliLogger.succeedSpinner('user-server-release', 'User server built (release)');
      return true;
    }

    cliLogger.failSpinner('user-server-release', 'Binary not found');
    return false;
  } catch (error) {
    cliLogger.failSpinner('user-server-release', 'Build failed');
    if (error instanceof Error) {
      cliLogger.error(error.message);
    }
    return false;
  }
}
