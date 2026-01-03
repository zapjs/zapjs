import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'fs';
import { cliLogger } from '../utils/logger.js';
import { resolveBinary, getPlatformIdentifier, resolveSpliceBinary } from '../utils/binary-resolver.js';
import { validateBuildStructure } from '../utils/build-validator.js';
import { buildUserServerRelease } from '../utils/user-server.js';

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
  const outputDir = resolve(options.output || './dist');
  const startTime = Date.now();

  try {
    cliLogger.header('ZapJS Production Build');

    // Step 1: Generate TypeScript bindings first (needed for type checking)
    if (!options.skipCodegen) {
      await runCodegen();
    }

    // Step 2: TypeScript type checking (optional but recommended)
    await typeCheck();

    // Step 2.5: Validate build structure
    cliLogger.spinner('validate', 'Validating build structure...');
    const validation = validateBuildStructure(process.cwd());

    if (!validation.valid) {
      cliLogger.failSpinner('validate', 'Build validation failed');
      for (const error of validation.errors) {
        cliLogger.error(error);
      }
      cliLogger.newline();
      cliLogger.error('Server imports found in restricted locations');
      cliLogger.newline();
      cliLogger.info('Allowed locations for server imports:');
      cliLogger.info('  - routes/api/** (server-side routes)');
      cliLogger.info('  - routes/ws/** (WebSocket routes)');
      cliLogger.info('  - src/api/** (API clients)');
      cliLogger.info('  - src/services/** (business logic)');
      cliLogger.info('  - src/generated/** (generated code)');
      cliLogger.newline();
      cliLogger.info('Move server imports to allowed directories or remove them.');
      throw new Error('Build validation failed');
    }

    if (validation.warnings.length > 0) {
      for (const warning of validation.warnings) {
        cliLogger.warn(warning);
      }
    }

    cliLogger.succeedSpinner('validate', 'Build structure valid');

    // Clean output directory
    if (existsSync(outputDir)) {
      cliLogger.spinner('clean', 'Cleaning output directory...');
      rmSync(outputDir, { recursive: true, force: true });
      cliLogger.succeedSpinner('clean', 'Output directory cleaned');
    }

    // Step 3: Build frontend first (if not skipped)
    // Vite will create the dist/ directory and populate it
    let staticDir: string | null = null;
    if (!options.skipFrontend) {
      staticDir = await buildFrontend(outputDir);
    }

    // Step 3.5: Compile server routes separately
    await compileRoutes(outputDir);

    // Step 4: Create bin directory and build Rust binary
    // This happens AFTER frontend build so Vite doesn't overwrite it
    mkdirSync(join(outputDir, 'bin'), { recursive: true });
    await buildRust(outputDir, options);

    // Step 4.5: Build user server and copy Splice binary (if available)
    await buildUserServerAndSplice(outputDir);

    // Step 5: Create production config
    await createProductionConfig(outputDir, staticDir);

    // Step 6: Create build manifest
    const manifest = createBuildManifest(outputDir, staticDir);
    writeFileSync(
      join(outputDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const binSize = getBinarySize(join(outputDir, 'bin', 'zap'));

    cliLogger.newline();
    cliLogger.success(`Build complete in ${elapsed}s`);
    cliLogger.newline();
    cliLogger.keyValue('Directory', outputDir);
    cliLogger.keyValue('Binary', binSize);
    if (staticDir) {
      cliLogger.keyValue('Static', join(outputDir, 'static'));
    }
    cliLogger.newline();
    cliLogger.command(`cd ${outputDir} && ./bin/zap`, 'Run in production');
    cliLogger.newline();

  } catch (error) {
    if (error instanceof Error) {
      cliLogger.error('Build failed', error);
    }
    process.exit(1);
  }
}

async function buildRust(
  outputDir: string,
  options: BuildOptions
): Promise<void> {
  const projectDir = process.cwd();

  // STEP 1: Try to use pre-built binary from platform package
  const prebuiltBinary = resolveBinary('zap', projectDir);

  if (prebuiltBinary && existsSync(prebuiltBinary)) {
    cliLogger.spinner('rust', 'Using pre-built binary...');
    const platformId = getPlatformIdentifier();

    try {
      // Copy pre-built binary to output directory
      const destBinary = join(outputDir, 'bin', 'zap');
      copyFileSync(prebuiltBinary, destBinary);
      execSync(`chmod +x "${destBinary}"`, { stdio: 'pipe' });

      cliLogger.succeedSpinner('rust', `Using pre-built binary for ${platformId}`);
      return;
    } catch (error) {
      cliLogger.failSpinner('rust', 'Failed to copy pre-built binary');
      throw error;
    }
  }

  // STEP 2: No pre-built binary found - check if we can build from source
  const cargoTomlPath = join(projectDir, 'Cargo.toml');

  if (!existsSync(cargoTomlPath)) {
    cliLogger.failSpinner('rust', 'No binary available');
    throw new Error(
      'Cannot build: No pre-built binary found and no Cargo.toml to build from source.\n' +
      '\n' +
      'Solutions:\n' +
      `1. Install platform package: npm install @zap-js/${getPlatformIdentifier()}\n` +
      '2. Or build from source by cloning the ZapJS repository'
    );
  }

  // STEP 3: Build from source with cargo
  cliLogger.spinner('rust', 'Building Rust backend from source (release mode)...');

  const args = ['build', '--release', '--bin', 'zap'];

  if (options.target) {
    args.push('--target', options.target);
  }

  try {
    execSync(`cargo ${args.join(' ')}`, {
      cwd: process.cwd(),
      stdio: 'inherit', // Show cargo output
    });

    const targetDir = options.target
      ? join('target', options.target, 'release')
      : join('target', 'release');

    // Get the default Rust target for this platform
    let defaultTarget = '';
    try {
      defaultTarget = execSync('rustc -vV | grep host | cut -d: -f2', {
        stdio: 'pipe',
        encoding: 'utf-8'
      }).trim();
    } catch {
      // Fallback targets based on platform
      if (process.platform === 'darwin' && process.arch === 'arm64') {
        defaultTarget = 'aarch64-apple-darwin';
      } else if (process.platform === 'darwin') {
        defaultTarget = 'x86_64-apple-darwin';
      } else if (process.platform === 'linux') {
        defaultTarget = 'x86_64-unknown-linux-gnu';
      }
    }

    const platformTargetDir = defaultTarget
      ? join('target', defaultTarget, 'release')
      : targetDir;

    // Try multiple locations for the binary (workspace vs local)
    const possibleBinaryPaths = [
      // Workspace target with platform-specific dir
      join(process.cwd(), '..', platformTargetDir, 'zap'),
      join(process.cwd(), '..', '..', platformTargetDir, 'zap'),
      // Workspace target standard
      join(process.cwd(), '..', targetDir, 'zap'),
      join(process.cwd(), '..', '..', targetDir, 'zap'),
      // Local target with platform-specific dir
      join(process.cwd(), platformTargetDir, 'zap'),
      // Local target standard
      join(process.cwd(), targetDir, 'zap'),
    ];

    let srcBinary: string | null = null;
    for (const path of possibleBinaryPaths) {
      if (existsSync(path)) {
        srcBinary = path;
        break;
      }
    }

    if (!srcBinary) {
      throw new Error(`Binary not found. Checked:\n${possibleBinaryPaths.join('\n')}`);
    }

    const destBinary = join(outputDir, 'bin', 'zap');
    copyFileSync(srcBinary, destBinary);
    execSync(`chmod +x "${destBinary}"`, { stdio: 'pipe' });

    cliLogger.succeedSpinner('rust', 'Rust backend built from source (release + LTO)');
  } catch (error) {
    cliLogger.failSpinner('rust', 'Rust build failed');
    throw error;
  }
}

async function buildFrontend(
  outputDir: string
): Promise<string | null> {
  const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']
    .find(f => existsSync(join(process.cwd(), f)));

  if (!viteConfig) {
    cliLogger.info('No Vite config found, skipping frontend build');
    return null;
  }

  cliLogger.spinner('vite', 'Building frontend (Vite)...');

  // Create temporary vite config that externalizes server packages
  const tempConfigPath = join(process.cwd(), '.vite.config.temp.mjs');
  const tempConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      external: [
        '@zap-js/server',
        '@zap-js/client/node',
        '@zap-js/client/server',
      ],
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
`;

  try {
    // Write temporary config
    writeFileSync(tempConfigPath, tempConfig);

    // Build to a temporary directory to avoid conflicts
    const tempDist = join(process.cwd(), '.dist-temp');

    // Clean temp directory if it exists
    if (existsSync(tempDist)) {
      rmSync(tempDist, { recursive: true, force: true });
    }

    execSync(`npx vite build --config ${tempConfigPath} --outDir ${tempDist}`, {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    // Clean up temp config
    rmSync(tempConfigPath, { force: true });

    const staticDir = join(outputDir, 'static');

    if (existsSync(tempDist)) {
      copyDirectory(tempDist, staticDir);
      // Clean up temp directory
      rmSync(tempDist, { recursive: true, force: true });
      cliLogger.succeedSpinner('vite', 'Frontend built and bundled');
      return staticDir;
    } else {
      cliLogger.warn('Vite build completed but no output found');
      return null;
    }
  } catch (error) {
    // Clean up temp config on error
    if (existsSync(tempConfigPath)) {
      rmSync(tempConfigPath, { force: true });
    }
    cliLogger.failSpinner('vite', 'Frontend build failed');
    cliLogger.warn('Continuing without frontend');
    return null;
  }
}

async function compileRoutes(outputDir: string): Promise<void> {
  const routesDir = join(process.cwd(), 'routes');

  if (!existsSync(routesDir)) {
    cliLogger.info('No routes directory, skipping route compilation');
    return;
  }

  cliLogger.spinner('routes', 'Compiling server routes...');

  const tempTsConfig = '.tsconfig.routes.json';

  try {
    // Create temporary tsconfig for routes only
    const routesTsConfig = {
      extends: './tsconfig.json',
      compilerOptions: {
        outDir: join(outputDir, 'routes'),
        rootDir: './routes',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: false,
        declaration: false,
        sourceMap: true,
      },
      include: ['routes/**/*.ts'],
      exclude: ['routes/**/*.tsx', 'node_modules']
    };

    writeFileSync(tempTsConfig, JSON.stringify(routesTsConfig, null, 2));

    execSync(`npx tsc --project ${tempTsConfig}`, {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    // Clean up temp config
    rmSync(tempTsConfig, { force: true });

    cliLogger.succeedSpinner('routes', 'Server routes compiled');
  } catch (error) {
    // Clean up temp config on error
    if (existsSync(tempTsConfig)) {
      rmSync(tempTsConfig, { force: true });
    }
    cliLogger.failSpinner('routes', 'Route compilation failed');
    // Don't throw - routes may not exist or may not need compilation
    cliLogger.warn('Continuing without compiled routes');
  }
}

async function typeCheck(): Promise<void> {
  // Check if tsconfig exists
  const tsconfigPath = join(process.cwd(), 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return; // Skip if no tsconfig
  }

  cliLogger.spinner('typecheck', 'Type checking TypeScript...');

  try {
    execSync('npx tsc --noEmit', {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    cliLogger.succeedSpinner('typecheck', 'TypeScript types OK');
  } catch (error) {
    cliLogger.warn('TypeScript type check failed (continuing build)');
    // Don't fail the build, just warn
  }
}

async function runCodegen(): Promise<void> {
  const projectDir = process.cwd();

  // Try to resolve codegen binary using binary resolver
  let codegenBinary = resolveBinary('zap-codegen', projectDir);

  // If not found, try workspace target locations (for development)
  if (!codegenBinary) {
    const possiblePaths = [
      join(projectDir, '../../target/release/zap-codegen'),
      join(projectDir, '../../target/aarch64-apple-darwin/release/zap-codegen'),
      join(projectDir, '../../target/x86_64-unknown-linux-gnu/release/zap-codegen'),
      join(projectDir, 'target/release/zap-codegen'),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        codegenBinary = path;
        break;
      }
    }
  }

  // Try global zap-codegen as final fallback
  if (!codegenBinary) {
    try {
      execSync('which zap-codegen', { stdio: 'pipe' });
      codegenBinary = 'zap-codegen';
    } catch {
      cliLogger.info('Codegen skipped (binary not found)');
      return;
    }
  }

  cliLogger.spinner('codegen', 'Generating TypeScript bindings...');

  try {
    execSync(`"${codegenBinary}" --output-dir ./src/api`, {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    cliLogger.succeedSpinner('codegen', 'TypeScript bindings generated');
  } catch (error) {
    cliLogger.warn('Codegen failed (continuing build)');
  }
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

/**
 * Build user's Rust server and copy Splice binary to dist/bin/
 */
async function buildUserServerAndSplice(outputDir: string): Promise<void> {
  const projectDir = process.cwd();

  // 1. Try to resolve pre-built Splice binary
  const spliceBinary = resolveSpliceBinary(projectDir);

  if (spliceBinary && existsSync(spliceBinary)) {
    cliLogger.spinner('splice', 'Copying Splice binary...');

    try {
      const destBinary = join(outputDir, 'bin', 'splice');
      copyFileSync(spliceBinary, destBinary);
      execSync(`chmod +x "${destBinary}"`, { stdio: 'pipe' });

      cliLogger.succeedSpinner('splice', 'Splice binary copied');
    } catch (error) {
      cliLogger.warn('Failed to copy Splice binary');
    }
  } else {
    cliLogger.info('Splice binary not found (skipping)');
  }

  // 2. Build user server if it exists
  const success = await buildUserServerRelease(projectDir, outputDir);

  if (!success) {
    // Warning already logged by buildUserServerRelease
    return;
  }
}
