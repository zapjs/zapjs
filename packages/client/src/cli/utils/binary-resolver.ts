import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolves the path to a ZapJS binary using multiple strategies:
 * 1. Platform-specific npm package (@zap-js/darwin-arm64, etc.)
 * 2. Local bin/ directory in user's project (for development/custom builds)
 * 3. Returns null to trigger cargo build fallback
 */
export function resolveBinary(
  binaryName: 'zap' | 'zap-codegen' | 'splice',
  projectDir?: string
): string | null {
  const platform = process.platform;
  const arch = process.arch;

  // Strategy 1: Try platform-specific npm package
  const platformPkg = `@zap-js/${platform}-${arch}`;
  try {
    // Try to resolve the platform package
    const pkgPath = require.resolve(`${platformPkg}/package.json`);
    const binPath = path.join(path.dirname(pkgPath), 'bin', binaryName);

    if (existsSync(binPath)) {
      return binPath;
    }
  } catch (err) {
    // Platform package not installed, continue to next strategy
  }

  // Strategy 2: Check local bin/ directory in user's project
  if (projectDir) {
    const localBin = path.join(projectDir, 'bin', binaryName);
    const localBinExe = path.join(projectDir, 'bin', `${binaryName}.exe`);

    if (existsSync(localBin)) {
      return localBin;
    }
    if (existsSync(localBinExe)) {
      return localBinExe;
    }
  }

  // Strategy 3: Return null (will trigger cargo build)
  return null;
}

/**
 * Detects both zap and zap-codegen binaries
 */
export function detectBinaries(projectDir: string): {
  binaryPath?: string;
  codegenBinaryPath?: string;
} {
  const binaryPath = resolveBinary('zap', projectDir);
  const codegenBinaryPath = resolveBinary('zap-codegen', projectDir);

  return {
    binaryPath: binaryPath || undefined,
    codegenBinaryPath: codegenBinaryPath || undefined,
  };
}

/**
 * Gets the platform identifier (e.g., "darwin-arm64")
 */
export function getPlatformIdentifier(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Checks if a platform-specific package is installed
 */
export function isPlatformPackageInstalled(): boolean {
  const platformPkg = `@zap-js/${getPlatformIdentifier()}`;
  try {
    require.resolve(`${platformPkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the Splice binary using the same resolution strategy
 *
 * Resolution order:
 * 1. Platform-specific npm package (@zap-js/darwin-arm64)
 * 2. Local bin/ directory (user's project)
 * 3. null (triggers cargo build fallback)
 */
export function resolveSpliceBinary(projectDir?: string): string | null {
  return resolveBinary('splice', projectDir);
}
