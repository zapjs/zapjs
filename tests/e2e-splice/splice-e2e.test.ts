import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SpliceTestHarness, invokeViaHttp } from './utils/splice-harness';
import { join } from 'path';

describe('Splice E2E Integration', () => {
  let harness: SpliceTestHarness;
  const port = 40000 + Math.floor(Math.random() * 10000);
  let zapServer: any;

  beforeAll(async () => {
    const projectDir = join(__dirname, '../..');

    // Determine platform-specific paths
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

    // TODO: Start Zap server once the HTTP server module is properly integrated
    // For now, these tests will be skipped until full integration is ready
    console.log('[Tests] Zap server integration pending - tests will be implemented after Part 2');

    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  it.skip('should invoke simple sync function', async () => {
    const result = await invokeViaHttp(port, 'hello_world', {});
    expect(result).toBe('Hello from Rust!');
  });

  it.skip('should invoke sync function with parameters', async () => {
    const result = await invokeViaHttp(port, 'add_numbers', { a: 10, b: 32 });
    expect(result).toBe(42);
  });

  it.skip('should invoke async function', async () => {
    const result = await invokeViaHttp(port, 'get_trace_info', {});
    expect(result).toHaveProperty('trace_id');
    expect(result).toHaveProperty('span_id');
  });

  it.skip('should handle user errors gracefully', async () => {
    try {
      await invokeViaHttp(port, 'process_user', {
        user: { name: 'Minor', age: 10, email: 'minor@example.com' },
      });
      expect(false).toBe(true);
    } catch (error: any) {
      expect(error.message).toContain('18 or older');
    }
  });

  it.skip('should handle missing parameters', async () => {
    try {
      await invokeViaHttp(port, 'add_numbers', { a: 5 });
      expect(false).toBe(true);
    } catch (error: any) {
      expect(error).toBeDefined();
    }
  });

  it.skip('should handle complex parameter types', async () => {
    const user = {
      name: 'Alice Smith',
      age: 30,
      email: 'alice@example.com',
    };

    const result = await invokeViaHttp(port, 'process_user', { user });
    expect(result).toContain('Processed user: Alice Smith');
  });

  it.skip('should handle high request volume', async () => {
    const requests = [];
    for (let i = 0; i < 100; i++) {
      requests.push(invokeViaHttp(port, 'add_numbers', { a: i, b: 1 }));
    }

    const results = await Promise.all(requests);
    expect(results.length).toBe(100);

    results.forEach((result, i) => {
      expect(result).toBe(i + 1);
    });

    console.log('[Test] Successfully processed 100 concurrent requests');
  });

  it.skip('should handle rapid sequential requests', async () => {
    for (let i = 0; i < 50; i++) {
      const result = await invokeViaHttp(port, 'add_numbers', { a: i, b: i });
      expect(result).toBe(i * 2);
    }

    console.log('[Test] Successfully processed 50 sequential requests');
  });

  it('should successfully build test-server binary', () => {
    const projectDir = join(__dirname, '../..');
    const arch = process.platform === 'darwin' && process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu';
    const workerBinary = join(projectDir, `target/${arch}/debug/test-server`);
    const { existsSync } = require('fs');
    expect(existsSync(workerBinary)).toBe(true);
  });

  it('should successfully start Splice harness', () => {
    expect(harness.isRunning()).toBe(true);
  });
});
