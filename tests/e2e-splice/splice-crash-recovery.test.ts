import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SpliceTestHarness, invokeViaHttp } from './utils/splice-harness';
import { join } from 'path';

describe('Splice Crash Recovery', () => {
  let harness: SpliceTestHarness;
  const port = 40000 + Math.floor(Math.random() * 10000);

  beforeAll(async () => {
    const projectDir = join(__dirname, '../..');
    const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
    const arch = process.platform === 'darwin' && process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu';
    const workerBinary = join(projectDir, `target/${arch}/debug/test-server`);
    const spliceBinary = join(projectDir, `packages/platforms/${platform}/bin/splice`);

    console.log('[Tests] Building test-server...');
    const { execSync } = await import('child_process');
    execSync('cargo build -p test-server', {
      cwd: projectDir,
      stdio: 'inherit',
    });

    harness = new SpliceTestHarness({
      workerBinaryPath: workerBinary,
      spliceBinaryPath: spliceBinary,
    });
    await harness.start();

    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  it.skip('should handle function panic and continue processing', async () => {
    // First, verify normal operation
    const result1 = await invokeViaHttp(port, 'hello_world', {});
    expect(result1).toBe('Hello from Rust!');

    // Trigger panic (worker will crash)
    console.log('[Test] Triggering panic...');
    try {
      await invokeViaHttp(port, 'panic_function', { should_panic: true });
    } catch (error) {
      console.log('[Test] Panic occurred as expected');
    }

    // Wait for supervisor to restart worker
    console.log('[Test] Waiting for restart...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify recovery - subsequent request should succeed
    const result2 = await invokeViaHttp(port, 'hello_world', {});
    expect(result2).toBe('Hello from Rust!');

    console.log('[Test] Crash recovery successful!');
  });

  it.skip('should handle multiple crashes with exponential backoff', async () => {
    const crashCount = 3;
    const timings: number[] = [];

    for (let i = 0; i < crashCount; i++) {
      const startTime = Date.now();

      try {
        await invokeViaHttp(port, 'panic_function', { should_panic: true });
      } catch {
        // Expected
      }

      // Wait for restart
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Verify recovery
      const result = await invokeViaHttp(port, 'hello_world', {});
      expect(result).toBe('Hello from Rust!');

      const elapsed = Date.now() - startTime;
      timings.push(elapsed);
      console.log(`[Test] Crash ${i + 1} recovery time: ${elapsed}ms`);
    }

    console.log('[Test] Recovery timings:', timings);
  });

  it.skip('should not crash on non-panic errors', async () => {
    // Call function that returns error (not panic)
    try {
      await invokeViaHttp(port, 'process_user', {
        user: { name: 'Child', age: 15, email: 'child@example.com' },
      });
      expect(false).toBe(true);
    } catch (error: any) {
      expect(error.message).toContain('must be 18');
    }

    // Worker should still be alive
    const result = await invokeViaHttp(port, 'hello_world', {});
    expect(result).toBe('Hello from Rust!');
  });

  it('should verify Splice is running', () => {
    expect(harness.isRunning()).toBe(true);
  });
});
