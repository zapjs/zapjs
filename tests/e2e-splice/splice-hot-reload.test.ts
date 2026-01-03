import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SpliceTestHarness, invokeViaHttp } from './utils/splice-harness';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

describe('Splice Hot Reload E2E', () => {
  let harness: SpliceTestHarness;
  const port = 40000 + Math.floor(Math.random() * 10000);
  let projectDir: string;
  let testServerDir: string;
  let libRsPath: string;
  let originalSource: string;

  beforeAll(async () => {
    projectDir = join(__dirname, '../..');
    testServerDir = join(__dirname, 'test-server');
    libRsPath = join(testServerDir, 'src/lib.rs');

    // Save original source
    originalSource = readFileSync(libRsPath, 'utf-8');

    // Initial build
    console.log('[Tests] Building test-server...');
    execSync('cargo build -p test-server', {
      cwd: projectDir,
      stdio: 'inherit',
    });

    const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
    const arch = process.platform === 'darwin' && process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu';
    const workerBinary = join(projectDir, `target/${arch}/debug/test-server`);
    const spliceBinary = join(projectDir, `packages/platforms/${platform}/bin/splice`);

    harness = new SpliceTestHarness({
      workerBinaryPath: workerBinary,
      spliceBinaryPath: spliceBinary,
    });
    await harness.start();

    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    // Restore original source
    if (originalSource) {
      writeFileSync(libRsPath, originalSource);
      execSync('cargo build', { cwd: testServerDir, stdio: 'inherit' });
    }

    if (harness) await harness.stop();
  });

  it.skip('should hot reload when binary changes', async () => {
    // Step 1: Get initial version
    const version1 = await invokeViaHttp(port, 'get_version', {});
    expect(version1).toBe(1);
    console.log('[Test] Initial version:', version1);

    // Step 2: Modify source code
    console.log('[Test] Modifying source code...');
    const modifiedSource = originalSource.replace('AtomicU32::new(1)', 'AtomicU32::new(2)');
    writeFileSync(libRsPath, modifiedSource);

    // Step 3: Rebuild binary
    console.log('[Test] Rebuilding binary...');
    execSync('cargo build', {
      cwd: testServerDir,
      stdio: 'inherit',
    });

    // Step 4: Wait for Splice to detect change and reload
    console.log('[Test] Waiting for hot reload...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Step 5: Verify new version is loaded
    const version2 = await invokeViaHttp(port, 'get_version', {});
    expect(version2).toBe(2);
    console.log('[Test] After reload version:', version2);

    console.log('[Test] Hot reload successful!');
  });

  it.skip('should maintain zero downtime during reload', async () => {
    const requestCount = 20;
    const results: Promise<any>[] = [];

    // Modify and rebuild
    const modifiedSource = originalSource.replace('AtomicU32::new(1)', 'AtomicU32::new(3)');
    writeFileSync(libRsPath, modifiedSource);

    execSync('cargo build', {
      cwd: testServerDir,
      stdio: 'pipe',
    });

    // Send requests during reload window
    for (let i = 0; i < requestCount; i++) {
      results.push(invokeViaHttp(port, 'hello_world', {}));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const allResults = await Promise.all(results);
    expect(allResults.length).toBe(requestCount);
    expect(allResults.every((r) => r === 'Hello from Rust!')).toBe(true);

    console.log('[Test] All requests succeeded during reload');
  });

  it.skip('should handle rapid rebuilds gracefully', async () => {
    for (let i = 4; i <= 6; i++) {
      const modifiedSource = originalSource.replace('AtomicU32::new(1)', `AtomicU32::new(${i})`);
      writeFileSync(libRsPath, modifiedSource);

      execSync('cargo build', { cwd: testServerDir, stdio: 'pipe' });

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const finalVersion = await invokeViaHttp(port, 'get_version', {});
    expect(finalVersion).toBe(6);

    console.log('[Test] Final version after rapid rebuilds:', finalVersion);
  });

  it('should verify Splice is running', () => {
    expect(harness.isRunning()).toBe(true);
  });
});
