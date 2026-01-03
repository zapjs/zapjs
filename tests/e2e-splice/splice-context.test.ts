import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SpliceTestHarness, invokeViaHttp } from './utils/splice-harness';
import { join } from 'path';

describe('Splice Context Propagation', () => {
  let harness: SpliceTestHarness;
  const port = 40000 + Math.floor(Math.random() * 10000);

  beforeAll(async () => {
    const projectDir = join(__dirname, '../..');
    const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
    const arch = process.platform === 'darwin' && process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu';
    const workerBinary = join(projectDir, `target/${arch}/debug/test-server`);
    const spliceBinary = join(projectDir, `packages/platforms/${platform}/bin/splice`);

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

  it.skip('should propagate trace_id and span_id', async () => {
    const result = await invokeViaHttp(
      port,
      'get_trace_info',
      {},
      {
        'X-Trace-Id': '12345',
      }
    );

    expect(result).toHaveProperty('trace_id');
    expect(result).toHaveProperty('span_id');
    expect(typeof result.trace_id).toBe('number');
    expect(typeof result.span_id).toBe('number');

    console.log('[Test] Trace context:', result);
  });

  it.skip('should propagate custom headers', async () => {
    const customHeaders = {
      'X-Custom-Header': 'test-value',
      'X-Request-Id': 'req-123',
      'Content-Type': 'application/json',
    };

    const result = await invokeViaHttp(port, 'echo_headers', {}, customHeaders);

    expect(result).toHaveProperty('headers');
    expect(Array.isArray(result.headers)).toBe(true);

    const headers = Object.fromEntries(
      result.headers.map((h: [string, string]) => [h[0].toLowerCase(), h[1]])
    );

    expect(headers['x-custom-header']).toBe('test-value');
    expect(headers['x-request-id']).toBe('req-123');

    console.log('[Test] Propagated headers:', headers);
  });

  it.skip('should propagate auth context (user_id and roles)', async () => {
    const result = await invokeViaHttp(
      port,
      'check_auth',
      {},
      {
        'X-User-Id': 'user-456',
        'X-User-Roles': 'admin,editor',
      }
    );

    expect(result.user_id).toBe('user-456');
    expect(result.is_admin).toBe(true);

    console.log('[Test] Auth context:', result);
  });

  it.skip('should handle missing auth context gracefully', async () => {
    try {
      await invokeViaHttp(port, 'check_auth', {});
      expect(false).toBe(true);
    } catch (error: any) {
      expect(error.message).toContain('Not authenticated');
    }
  });

  it.skip('should propagate context with complex parameters', async () => {
    const user = {
      name: 'Alice',
      age: 25,
      email: 'alice@example.com',
    };

    const result = await invokeViaHttp(port, 'process_user', { user }, {
      'X-Trace-Id': 'trace-789',
      'X-Request-Source': 'test-suite',
    });

    expect(result).toContain('Processed user: Alice');
  });

  it('should verify Splice is running', () => {
    expect(harness.isRunning()).toBe(true);
  });
});
