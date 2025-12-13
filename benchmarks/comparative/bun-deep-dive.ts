#!/usr/bin/env bun
/**
 * Comprehensive Bun HTTP vs ZapJS Comparison
 *
 * Deep dive comparison with multiple scenarios, connection counts,
 * and payload sizes to get the complete performance picture.
 */

import { spawn, spawnSync } from 'child_process';
import { writeFileSync } from 'fs';

interface BenchmarkResult {
    scenario: string;
    connections: number;
    framework: string;
    rps: number;
    latency_avg_ms: number;
    latency_p50_ms: number;
    latency_p90_ms: number;
    latency_p99_ms: number;
    latency_max_ms: number;
    transfer_per_sec: string;
}

const SCENARIOS = [
    {
        name: 'hello_world',
        path: '/',
        description: 'Minimal "Hello World" response',
    },
    {
        name: 'json_small',
        path: '/api/users/123',
        description: 'Small JSON response (~100 bytes)',
    },
    {
        name: 'json_medium',
        path: '/api/users',
        description: 'Medium JSON response (~500 bytes, 10 items)',
    },
    {
        name: 'health_check',
        path: '/health',
        description: 'Health check endpoint',
    },
    {
        name: 'route_params_simple',
        path: '/api/users/42',
        description: 'Single route parameter',
    },
    {
        name: 'route_params_nested',
        path: '/api/users/42/posts/99',
        description: 'Nested route parameters',
    },
];

const CONNECTION_COUNTS = [10, 50, 100, 200, 500];
const DURATION = 15; // 15 seconds per test
const THREADS = 4;
const WARMUP_DURATION = 3; // 3 second warmup

const parseWrkOutput = (output: string): Partial<BenchmarkResult> => {
    const lines = output.split('\n');
    const result: Partial<BenchmarkResult> = {};

    for (const line of lines) {
        // Parse "Requests/sec: 12345.67"
        if (line.includes('Requests/sec:')) {
            const match = line.match(/Requests\/sec:\s+([\d.]+)/);
            if (match) result.rps = parseFloat(match[1]);
        }

        // Parse "Transfer/sec: 1.23MB"
        if (line.includes('Transfer/sec:')) {
            const match = line.match(/Transfer\/sec:\s+([\d.]+\w+)/);
            if (match) result.transfer_per_sec = match[1];
        }

        // Parse latency line: "    Latency    1.23ms    2.45ms   10.67ms   89.12%"
        if (line.trim().startsWith('Latency') && line.includes('ms')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
                const avg = parts[1].replace('ms', '');
                result.latency_avg_ms = parseFloat(avg);
            }
        }

        // Parse percentile lines
        if (line.includes('50.000%')) {
            const match = line.match(/([\d.]+)ms/);
            if (match) result.latency_p50_ms = parseFloat(match[1]);
        }
        if (line.includes('90.000%')) {
            const match = line.match(/([\d.]+)ms/);
            if (match) result.latency_p90_ms = parseFloat(match[1]);
        }
        if (line.includes('99.000%')) {
            const match = line.match(/([\d.]+)ms/);
            if (match) result.latency_p99_ms = parseFloat(match[1]);
        }
        if (line.includes('100.000%')) {
            const match = line.match(/([\d.]+)ms/);
            if (match) result.latency_max_ms = parseFloat(match[1]);
        }
    }

    return result;
};

const runWrk = async (
    url: string,
    connections: number,
    duration: number,
    threads: number
): Promise<string> => {
    return new Promise((resolve, reject) => {
        const args = [
            '-t', threads.toString(),
            '-c', connections.toString(),
            '-d', `${duration}s`,
            '--latency',
            url,
        ];

        const proc = spawn('wrk', args);
        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', (data) => {
            output += data.toString();
        });

        proc.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`wrk failed: ${errorOutput}`));
            } else {
                resolve(output);
            }
        });
    });
};

const startServer = async (
    name: string,
    command: string,
    args: string[],
    port: number
): Promise<any> => {
    console.log(`🚀 Starting ${name} server on port ${port}...`);

    const proc = spawn(command, args, {
        env: { ...process.env, PORT: port.toString() },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for server to be ready
    await new Promise((resolve) => {
        const checkServer = setInterval(async () => {
            try {
                const response = await fetch(`http://localhost:${port}/health`);
                if (response.ok) {
                    clearInterval(checkServer);
                    resolve(null);
                }
            } catch (e) {
                // Server not ready yet
            }
        }, 100);
    });

    console.log(`✅ ${name} server ready\n`);
    return proc;
};

const stopServer = (proc: any) => {
    if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        // Give it a moment to clean up
        setTimeout(() => {
            if (!proc.killed) {
                proc.kill('SIGKILL');
            }
        }, 1000);
    }
};

const main = async () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Bun HTTP vs ZapJS - Comprehensive Deep Dive');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log(`📊 Test Configuration:`);
    console.log(`   - Scenarios: ${SCENARIOS.length}`);
    console.log(`   - Connection counts: ${CONNECTION_COUNTS.join(', ')}`);
    console.log(`   - Duration: ${DURATION}s per test`);
    console.log(`   - Warmup: ${WARMUP_DURATION}s`);
    console.log(`   - Threads: ${THREADS}`);
    console.log('');

    const allResults: BenchmarkResult[] = [];

    // Test Bun HTTP
    console.log('\x1b[36m━━━ Bun HTTP ━━━\x1b[0m\n');
    let bunProc = await startServer('Bun HTTP', 'bun', ['servers/bun-server.ts'], 3003);

    for (const scenario of SCENARIOS) {
        console.log(`\x1b[36m📊 ${scenario.description}\x1b[0m`);

        for (const connections of CONNECTION_COUNTS) {
            process.stdout.write(`   ${connections} connections: `);

            // Warmup
            await runWrk(`http://localhost:3003${scenario.path}`, connections, WARMUP_DURATION, THREADS);

            // Actual test
            const output = await runWrk(`http://localhost:3003${scenario.path}`, connections, DURATION, THREADS);
            const parsed = parseWrkOutput(output);

            const result: BenchmarkResult = {
                scenario: scenario.name,
                connections,
                framework: 'Bun HTTP',
                rps: parsed.rps || 0,
                latency_avg_ms: parsed.latency_avg_ms || 0,
                latency_p50_ms: parsed.latency_p50_ms || 0,
                latency_p90_ms: parsed.latency_p90_ms || 0,
                latency_p99_ms: parsed.latency_p99_ms || 0,
                latency_max_ms: parsed.latency_max_ms || 0,
                transfer_per_sec: parsed.transfer_per_sec || 'N/A',
            };

            allResults.push(result);
            console.log(`${(result.rps / 1000).toFixed(1)}k RPS, ${result.latency_avg_ms.toFixed(2)}ms avg`);
        }
        console.log('');
    }

    stopServer(bunProc);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Cool down

    // Test ZapJS (using zaptest server)
    console.log('\n\x1b[32m━━━ ZapJS ━━━\x1b[0m\n');
    console.log('🚀 Starting ZapJS server (zaptest)...');

    const zapProc = spawn('bun', ['run', 'dev'], {
        cwd: '../../zaptest',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for server to be ready
    await new Promise((resolve) => {
        const checkServer = setInterval(async () => {
            try {
                const response = await fetch('http://localhost:3000/health');
                if (response.ok) {
                    clearInterval(checkServer);
                    resolve(null);
                }
            } catch (e) {
                // Server not ready yet
            }
        }, 100);
    });

    console.log('✅ ZapJS server ready\n');

    for (const scenario of SCENARIOS) {
        console.log(`\x1b[36m📊 ${scenario.description}\x1b[0m`);

        for (const connections of CONNECTION_COUNTS) {
            process.stdout.write(`   ${connections} connections: `);

            // Warmup
            await runWrk(`http://localhost:3000${scenario.path}`, connections, WARMUP_DURATION, THREADS);

            // Actual test
            const output = await runWrk(`http://localhost:3000${scenario.path}`, connections, DURATION, THREADS);
            const parsed = parseWrkOutput(output);

            const result: BenchmarkResult = {
                scenario: scenario.name,
                connections,
                framework: 'ZapJS',
                rps: parsed.rps || 0,
                latency_avg_ms: parsed.latency_avg_ms || 0,
                latency_p50_ms: parsed.latency_p50_ms || 0,
                latency_p90_ms: parsed.latency_p90_ms || 0,
                latency_p99_ms: parsed.latency_p99_ms || 0,
                latency_max_ms: parsed.latency_max_ms || 0,
                transfer_per_sec: parsed.transfer_per_sec || 'N/A',
            };

            allResults.push(result);
            console.log(`${(result.rps / 1000).toFixed(1)}k RPS, ${result.latency_avg_ms.toFixed(2)}ms avg`);
        }
        console.log('');
    }

    stopServer(zapProc);

    // Generate comparison report
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Detailed Comparison Results');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    for (const scenario of SCENARIOS) {
        console.log(`\n\x1b[1m📊 ${scenario.description}\x1b[0m`);
        console.log('─'.repeat(70));
        console.log('Connections │ Bun HTTP RPS │ ZapJS RPS   │ Speedup │ Bun HTTP Lat │ ZapJS Lat');
        console.log('─'.repeat(70));

        for (const connections of CONNECTION_COUNTS) {
            const bunResult = allResults.find(
                r => r.framework === 'Bun HTTP' && r.scenario === scenario.name && r.connections === connections
            );
            const zapResult = allResults.find(
                r => r.framework === 'ZapJS' && r.scenario === scenario.name && r.connections === connections
            );

            if (bunResult && zapResult) {
                const speedup = zapResult.rps / bunResult.rps;
                const speedupColor = speedup >= 3 ? '\x1b[32m' : speedup >= 2 ? '\x1b[33m' : '\x1b[31m';

                console.log(
                    `${connections.toString().padStart(11)} │ ` +
                    `${(bunResult.rps / 1000).toFixed(1).padStart(9)}k │ ` +
                    `${(zapResult.rps / 1000).toFixed(1).padStart(9)}k │ ` +
                    `${speedupColor}${speedup.toFixed(2)}x\x1b[0m`.padEnd(20) + `│ ` +
                    `${bunResult.latency_avg_ms.toFixed(2).padStart(9)}ms │ ` +
                    `${zapResult.latency_avg_ms.toFixed(2).padStart(7)}ms`
                );
            }
        }
    }

    // Calculate overall statistics
    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Overall Statistics');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const bunResults = allResults.filter(r => r.framework === 'Bun HTTP');
    const zapResults = allResults.filter(r => r.framework === 'ZapJS');

    const avgBunHTTPRPS = bunResults.reduce((sum, r) => sum + r.rps, 0) / bunResults.length;
    const avgZapRPS = zapResults.reduce((sum, r) => sum + r.rps, 0) / zapResults.length;
    const overallSpeedup = avgZapRPS / avgBunHTTPRPS;

    const minSpeedup = Math.min(
        ...SCENARIOS.flatMap(s =>
            CONNECTION_COUNTS.map(c => {
                const exp = allResults.find(r => r.framework === 'Bun HTTP' && r.scenario === s.name && r.connections === c);
                const zap = allResults.find(r => r.framework === 'ZapJS' && r.scenario === s.name && r.connections === c);
                return exp && zap ? zap.rps / exp.rps : 0;
            })
        )
    );

    const maxSpeedup = Math.max(
        ...SCENARIOS.flatMap(s =>
            CONNECTION_COUNTS.map(c => {
                const exp = allResults.find(r => r.framework === 'Bun HTTP' && r.scenario === s.name && r.connections === c);
                const zap = allResults.find(r => r.framework === 'ZapJS' && r.scenario === s.name && r.connections === c);
                return exp && zap ? zap.rps / exp.rps : 0;
            })
        )
    );

    console.log(`📈 Average Bun HTTP RPS: ${(avgBunHTTPRPS / 1000).toFixed(1)}k`);
    console.log(`📈 Average ZapJS RPS:      ${(avgZapRPS / 1000).toFixed(1)}k`);
    console.log('');
    console.log(`🏆 Overall Speedup: \x1b[1m\x1b[32m${overallSpeedup.toFixed(2)}x\x1b[0m`);
    console.log(`   Min speedup: ${minSpeedup.toFixed(2)}x`);
    console.log(`   Max speedup: ${maxSpeedup.toFixed(2)}x`);
    console.log('');

    // Find best scenarios for ZapJS
    const scenarioAverages = SCENARIOS.map(scenario => {
        const scenarioResults = allResults.filter(r => r.scenario === scenario.name);
        const bunAvg = scenarioResults
            .filter(r => r.framework === 'Bun HTTP')
            .reduce((sum, r) => sum + r.rps, 0) / CONNECTION_COUNTS.length;
        const zapAvg = scenarioResults
            .filter(r => r.framework === 'ZapJS')
            .reduce((sum, r) => sum + r.rps, 0) / CONNECTION_COUNTS.length;

        return {
            scenario: scenario.description,
            speedup: zapAvg / bunAvg,
        };
    }).sort((a, b) => b.speedup - a.speedup);

    console.log(`\x1b[1m🎯 Best Scenarios for ZapJS:\x1b[0m`);
    scenarioAverages.slice(0, 3).forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.scenario}: \x1b[32m${s.speedup.toFixed(2)}x\x1b[0m`);
    });

    // Save results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = `../reports/bun-deep-dive_${timestamp}.json`;
    writeFileSync(reportPath, JSON.stringify(allResults, null, 2));
    console.log(`\n📁 Full report saved to: ${reportPath}`);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
};

main().catch(console.error);
