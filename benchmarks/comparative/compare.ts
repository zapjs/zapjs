#!/usr/bin/env bun
/**
 * Framework Comparison Runner
 *
 * Compares ZapJS performance against Express, Fastify, and Bun
 * Validates the "10-100x faster than Express" claim
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Framework configurations
const FRAMEWORKS = [
    {
        name: 'Express.js',
        port: 3001,
        command: 'node',
        args: ['servers/express-server.cjs'],
        color: '\x1b[33m', // Yellow
    },
    {
        name: 'Fastify',
        port: 3002,
        command: 'node',
        args: ['servers/fastify-server.cjs'],
        color: '\x1b[36m', // Cyan
    },
    {
        name: 'Bun HTTP',
        port: 3003,
        command: 'bun',
        args: ['servers/bun-server.ts'],
        color: '\x1b[35m', // Magenta
    },
    {
        name: 'ZapJS',
        port: 3000,
        command: 'bun',
        args: ['servers/zap-server.ts'],
        color: '\x1b[32m', // Green
    },
];

// Test scenarios
const SCENARIOS = [
    {
        name: 'hello_world',
        path: '/',
        description: 'Simple "Hello World" response',
    },
    {
        name: 'json_static',
        path: '/health',
        description: 'JSON response (static)',
    },
    {
        name: 'json_dynamic',
        path: '/api/users/123',
        description: 'JSON with route parameter',
    },
    {
        name: 'json_list',
        path: '/api/users',
        description: 'JSON array response',
    },
    {
        name: 'nested_params',
        path: '/api/users/123/posts/456',
        description: 'Nested route parameters',
    },
];

// Benchmark configuration
const DURATION = '10s';
const THREADS = 4;
const CONNECTIONS = 100;

interface BenchmarkResult {
    framework: string;
    scenario: string;
    requests: number;
    rps: number;
    latency_avg: number;
    latency_p50: number;
    latency_p90: number;
    latency_p99: number;
    latency_max: number;
}

const results: BenchmarkResult[] = [];

// Utility functions
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const waitForServer = async (port: number, maxAttempts = 30): Promise<boolean> => {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const response = await fetch(`http://localhost:${port}/health`);
            if (response.ok) return true;
        } catch {
            // Server not ready
        }
        await sleep(1000);
    }
    return false;
};

const parseWrkOutput = (output: string): Partial<BenchmarkResult> => {
    const lines = output.split('\n');
    const result: Partial<BenchmarkResult> = {};

    for (const line of lines) {
        if (line.includes('Requests/sec:')) {
            const match = line.match(/([\d.]+)/);
            if (match) result.rps = parseFloat(match[1]);
        }
        if (line.includes('requests in')) {
            const match = line.match(/([\d.]+)M? requests/);
            if (match) {
                const val = parseFloat(match[1]);
                result.requests = match[0].includes('M') ? val * 1_000_000 : val;
            }
        }
        if (line.includes('Latency') && !line.includes('Distribution')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
                const parseLatency = (val: string) => {
                    if (val.endsWith('ms')) return parseFloat(val);
                    if (val.endsWith('us')) return parseFloat(val) / 1000;
                    if (val.endsWith('s')) return parseFloat(val) * 1000;
                    return parseFloat(val);
                };
                result.latency_avg = parseLatency(parts[1]);
            }
        }
        // Parse percentiles from distribution
        if (line.includes('50%')) {
            const match = line.match(/([\d.]+)(ms|us|s)/);
            if (match) {
                const val = parseFloat(match[1]);
                const unit = match[2];
                result.latency_p50 = unit === 'ms' ? val : unit === 'us' ? val / 1000 : val * 1000;
            }
        }
        if (line.includes('90%')) {
            const match = line.match(/([\d.]+)(ms|us|s)/);
            if (match) {
                const val = parseFloat(match[1]);
                const unit = match[2];
                result.latency_p90 = unit === 'ms' ? val : unit === 'us' ? val / 1000 : val * 1000;
            }
        }
        if (line.includes('99%')) {
            const match = line.match(/([\d.]+)(ms|us|s)/);
            if (match) {
                const val = parseFloat(match[1]);
                const unit = match[2];
                result.latency_p99 = unit === 'ms' ? val : unit === 'us' ? val / 1000 : val * 1000;
            }
        }
    }

    return result;
};

const runBenchmark = async (
    framework: string,
    scenario: string,
    port: number
): Promise<Partial<BenchmarkResult>> => {
    const url = `http://localhost:${port}${SCENARIOS.find(s => s.name === scenario)?.path}`;

    console.log(`  Running wrk (${DURATION})...`);

    const result = spawnSync('wrk', [
        `-t${THREADS}`,
        `-c${CONNECTIONS}`,
        `-d${DURATION}`,
        '--latency',
        url
    ], { encoding: 'utf-8' });

    if (result.error) {
        throw new Error(`wrk failed: ${result.error.message}`);
    }

    return parseWrkOutput(result.stdout);
};

// Main comparison
const main = async () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Framework Performance Comparison');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Check if wrk is installed
    const wrkCheck = spawnSync('which', ['wrk']);
    if (wrkCheck.status !== 0) {
        console.error('❌ wrk not found. Please install it first:');
        console.error('   macOS: brew install wrk');
        console.error('   Linux: sudo apt-get install wrk');
        process.exit(1);
    }

    for (const framework of FRAMEWORKS) {
        console.log(`${framework.color}━━━ ${framework.name} (port ${framework.port}) ━━━\x1b[0m`);
        console.log('');

        // Start server
        console.log(`🚀 Starting ${framework.name} server...`);
        const serverProcess = spawn(framework.command, framework.args, {
            cwd: __dirname,
            env: { ...process.env, PORT: framework.port.toString() },
            stdio: 'ignore',
        });

        // Wait for server to be ready
        const ready = await waitForServer(framework.port);
        if (!ready) {
            console.error(`❌ ${framework.name} failed to start`);
            serverProcess.kill();
            continue;
        }

        console.log(`✅ Server ready`);
        console.log('');

        // Warmup
        console.log('🔥 Warming up...');
        await fetch(`http://localhost:${framework.port}/health`);
        await sleep(2000);

        // Run benchmarks for each scenario
        for (const scenario of SCENARIOS) {
            console.log(`📊 ${scenario.description}`);

            try {
                const benchResult = await runBenchmark(
                    framework.name,
                    scenario.name,
                    framework.port
                );

                results.push({
                    framework: framework.name,
                    scenario: scenario.name,
                    requests: benchResult.requests || 0,
                    rps: benchResult.rps || 0,
                    latency_avg: benchResult.latency_avg || 0,
                    latency_p50: benchResult.latency_p50 || 0,
                    latency_p90: benchResult.latency_p90 || 0,
                    latency_p99: benchResult.latency_p99 || 0,
                    latency_max: benchResult.latency_max || 0,
                });

                console.log(`   RPS: ${benchResult.rps?.toLocaleString() || 'N/A'}`);
                console.log(`   Latency (avg): ${benchResult.latency_avg?.toFixed(2) || 'N/A'}ms`);
            } catch (error) {
                console.error(`   ❌ Failed: ${error}`);
            }

            console.log('');
        }

        // Kill server
        serverProcess.kill();
        await sleep(1000);

        console.log('');
    }

    // Generate comparison report
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Comparison Summary');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Group by scenario
    for (const scenario of SCENARIOS) {
        console.log(`📊 ${scenario.description}`);
        console.log('');

        const scenarioResults = results.filter(r => r.scenario === scenario.name);
        const expressResult = scenarioResults.find(r => r.framework === 'Express.js');

        if (!expressResult) continue;

        const sorted = scenarioResults.sort((a, b) => b.rps - a.rps);

        for (const result of sorted) {
            const speedup = (result.rps / expressResult.rps).toFixed(1);
            const isFastest = result.rps === sorted[0].rps;

            console.log(`  ${isFastest ? '🏆' : '  '} ${result.framework.padEnd(12)} ${result.rps.toLocaleString().padStart(10)} RPS (${speedup}x Express)`);
        }

        console.log('');
    }

    // Save JSON report
    const reportDir = join(__dirname, '../reports');
    if (!existsSync(reportDir)) {
        mkdirSync(reportDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = join(reportDir, `comparison_${timestamp}.json`);

    writeFileSync(reportPath, JSON.stringify({ results, timestamp: new Date() }, null, 2));

    console.log(`📁 Full report saved to: ${reportPath}`);
    console.log('');

    // Validate "10-100x faster" claim
    const zapResults = results.filter(r => r.framework === 'ZapJS');
    const expressResults = results.filter(r => r.framework === 'Express.js');

    if (zapResults.length > 0 && expressResults.length > 0) {
        const avgSpeedup = zapResults.reduce((sum, zap) => {
            const express = expressResults.find(e => e.scenario === zap.scenario);
            return sum + (express ? zap.rps / express.rps : 0);
        }, 0) / zapResults.length;

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Average speedup vs Express: ${avgSpeedup.toFixed(1)}x`);

        if (avgSpeedup >= 10) {
            console.log('✅ PASS: Validated "10-100x faster" claim');
        } else {
            console.log(`⚠️  WARNING: Below 10x target (got ${avgSpeedup.toFixed(1)}x)`);
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }
};

main().catch(console.error);
