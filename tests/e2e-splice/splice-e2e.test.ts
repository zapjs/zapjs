import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SpliceTestHarness, invokeViaRpc } from './utils/splice-harness';
import { initRpcClient } from '../../packages/client/src/runtime/rpc-client';
import { join } from 'path';

describe('Splice E2E Integration', () => {
  let harness: SpliceTestHarness;

  beforeAll(async () => {
    const projectDir = join(__dirname, '../..');

    // Determine platform-specific paths
    const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
    const arch = process.platform === 'darwin' && process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu';
    const workerBinary = join(projectDir, `target/${arch}/debug/test-server`);
    const spliceBinary = join(projectDir, `packages/platforms/${platform}/bin/splice`);
    const zapBinary = join(projectDir, `packages/platforms/${platform}/bin/zap`);

    console.log('[Tests] Building test-server...');
    const { execSync } = await import('child_process');
    execSync('cargo build -p test-server', {
      cwd: projectDir,
      stdio: 'inherit',
    });

    harness = new SpliceTestHarness({
      workerBinaryPath: workerBinary,
      spliceBinaryPath: spliceBinary,
      zapBinaryPath: zapBinary,
    });
    await harness.start();

    // Initialize RPC client (add .rpc extension to socket path)
    const ipcSocketPath = harness.getIpcSocketPath();
    await initRpcClient(`${ipcSocketPath}.rpc`);
    console.log('[Tests] RPC client initialized');
  });

  afterAll(async () => {
    if (harness) await harness.stop();
  });

  it('should invoke simple sync function', async () => {
    const result = await invokeViaRpc<string>('hello_world', {});
    expect(result).toBe('Hello from Rust!');
  });

  it('should invoke sync function with parameters', async () => {
    const result = await invokeViaRpc<number>('add_numbers', { a: 10, b: 32 });
    expect(result).toBe(42);
  });

  it('should invoke async function', async () => {
    const result = await invokeViaRpc<{ trace_id: number; span_id: number }>('get_trace_info', {});
    expect(result).toHaveProperty('trace_id');
    expect(result).toHaveProperty('span_id');
  });

  it('should handle user errors gracefully', async () => {
    try {
      await invokeViaRpc('process_user', {
        user: { name: 'Minor', age: 10, email: 'minor@example.com' },
      });
      expect(false).toBe(true);
    } catch (error: any) {
      expect(error.message).toContain('18 or older');
    }
  });

  it('should handle missing parameters', async () => {
    try {
      await invokeViaRpc('add_numbers', { a: 5 });
      expect(false).toBe(true);
    } catch (error: any) {
      expect(error).toBeDefined();
    }
  });

  it('should handle complex parameter types', async () => {
    const user = {
      name: 'Alice Smith',
      age: 30,
      email: 'alice@example.com',
    };

    const result = await invokeViaRpc<string>('process_user', { user });
    expect(result).toContain('Processed user: Alice Smith');
  });

  it('should handle high request volume', async () => {
    const requests = [];
    for (let i = 0; i < 100; i++) {
      requests.push(invokeViaRpc<number>('add_numbers', { a: i, b: 1 }));
    }

    const results = await Promise.all(requests);
    expect(results.length).toBe(100);

    results.forEach((result, i) => {
      expect(result).toBe(i + 1);
    });

    console.log('[Test] Successfully processed 100 concurrent requests');
  });

  it('should handle rapid sequential requests', async () => {
    for (let i = 0; i < 50; i++) {
      const result = await invokeViaRpc<number>('add_numbers', { a: i, b: i });
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
