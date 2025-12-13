#!/usr/bin/env bun
/**
 * Performance Regression Detection
 *
 * Compares current benchmark results against baseline
 * Fails CI if performance degrades beyond threshold
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface BenchmarkMetrics {
    // Router benchmarks (nanoseconds)
    router_static_lookup_ns?: number;
    router_dynamic_lookup_ns?: number;

    // HTTP parser benchmarks (nanoseconds)
    http_parser_simple_get_ns?: number;
    http_parser_with_headers_ns?: number;

    // IPC benchmarks (microseconds)
    ipc_json_serialize_us?: number;
    ipc_msgpack_serialize_us?: number;

    // Load test benchmarks (requests per second)
    rps_static_route?: number;
    rps_dynamic_route?: number;
    rps_mixed_workload?: number;

    // Additional metrics
    [key: string]: number | undefined;
}

interface ComparisonResult {
    metric: string;
    baseline: number;
    current: number;
    change_pct: number;
    threshold: number;
    passed: boolean;
    better_is_lower: boolean;
}

const REGRESSION_THRESHOLD = 0.10; // 10% regression threshold

// Metrics where lower is better (latency)
const LOWER_IS_BETTER = new Set([
    'router_static_lookup_ns',
    'router_dynamic_lookup_ns',
    'http_parser_simple_get_ns',
    'http_parser_with_headers_ns',
    'ipc_json_serialize_us',
    'ipc_msgpack_serialize_us',
]);

const loadBaseline = (path: string): BenchmarkMetrics => {
    if (!existsSync(path)) {
        throw new Error(`Baseline file not found: ${path}`);
    }

    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
};

const loadCurrent = (path: string): BenchmarkMetrics => {
    if (!existsSync(path)) {
        throw new Error(`Current results file not found: ${path}`);
    }

    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
};

const compareMetrics = (
    baseline: BenchmarkMetrics,
    current: BenchmarkMetrics,
    threshold: number
): ComparisonResult[] => {
    const results: ComparisonResult[] = [];

    // Get all metrics present in both baseline and current
    const metrics = new Set([...Object.keys(baseline), ...Object.keys(current)]);

    for (const metric of metrics) {
        const baselineVal = baseline[metric];
        const currentVal = current[metric];

        // Skip if either value is missing or not a number
        if (baselineVal === undefined || currentVal === undefined) {
            continue;
        }

        // Skip non-numeric fields (metadata)
        if (typeof baselineVal !== 'number' || typeof currentVal !== 'number') {
            continue;
        }

        const betterIsLower = LOWER_IS_BETTER.has(metric);

        // Calculate percentage change
        const changePct = ((currentVal - baselineVal) / baselineVal) * 100;

        // Determine if regression occurred
        let passed: boolean;
        if (betterIsLower) {
            // For latency metrics: increase is bad
            passed = changePct <= threshold * 100;
        } else {
            // For throughput metrics: decrease is bad
            passed = changePct >= -threshold * 100;
        }

        results.push({
            metric,
            baseline: baselineVal,
            current: currentVal,
            change_pct: changePct,
            threshold: threshold * 100,
            passed,
            better_is_lower: betterIsLower,
        });
    }

    return results;
};

const formatMetricName = (metric: string): string => {
    return metric
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
};

const formatValue = (value: number, metric: string): string => {
    if (metric.endsWith('_ns')) {
        return `${value.toFixed(2)}ns`;
    } else if (metric.endsWith('_us')) {
        return `${value.toFixed(2)}μs`;
    } else if (metric.startsWith('rps_')) {
        return `${(value / 1000).toFixed(1)}k RPS`;
    }
    return value.toFixed(2);
};

const printReport = (results: ComparisonResult[]) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Performance Regression Analysis');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    let totalTests = 0;
    let passedTests = 0;
    let regressions = 0;
    let improvements = 0;

    for (const result of results) {
        totalTests++;
        if (result.passed) passedTests++;

        const changeSign = result.change_pct >= 0 ? '+' : '';
        const changeColor = result.passed ? '\x1b[32m' : '\x1b[31m'; // Green or Red
        const resetColor = '\x1b[0m';

        // Determine if it's a regression or improvement
        const isImprovement = result.better_is_lower
            ? result.change_pct < 0
            : result.change_pct > 0;

        if (!result.passed) {
            regressions++;
        } else if (isImprovement && Math.abs(result.change_pct) > 5) {
            improvements++;
        }

        const status = result.passed ? '✅' : '❌';
        const trend = isImprovement ? '📈' : '📉';

        console.log(`${status} ${formatMetricName(result.metric)}`);
        console.log(`   Baseline: ${formatValue(result.baseline, result.metric)}`);
        console.log(`   Current:  ${formatValue(result.current, result.metric)}`);
        console.log(`   Change:   ${changeColor}${changeSign}${result.change_pct.toFixed(2)}%${resetColor} ${trend}`);

        if (!result.passed) {
            console.log(`   ⚠️  REGRESSION: Exceeds ${result.threshold}% threshold`);
        } else if (isImprovement && Math.abs(result.change_pct) > 5) {
            console.log(`   🎉 IMPROVEMENT: ${Math.abs(result.change_pct).toFixed(1)}% faster`);
        }

        console.log('');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Summary: ${passedTests}/${totalTests} tests passed`);

    if (regressions > 0) {
        console.log(`  ❌ ${regressions} regression(s) detected`);
    }
    if (improvements > 0) {
        console.log(`  🎉 ${improvements} improvement(s) detected`);
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    return passedTests === totalTests;
};

// Main
const main = () => {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.error('Usage: detect-regression.ts <baseline.json> <current.json> [threshold]');
        console.error('');
        console.error('Example:');
        console.error('  bun detect-regression.ts baselines/main.json results/pr-123.json');
        console.error('  bun detect-regression.ts baselines/main.json results/pr-123.json 0.15');
        process.exit(1);
    }

    const baselinePath = args[0];
    const currentPath = args[1];
    const threshold = args[2] ? parseFloat(args[2]) : REGRESSION_THRESHOLD;

    console.log(`📊 Comparing performance...`);
    console.log(`   Baseline: ${baselinePath}`);
    console.log(`   Current:  ${currentPath}`);
    console.log(`   Threshold: ${(threshold * 100).toFixed(0)}%`);
    console.log('');

    try {
        const baseline = loadBaseline(baselinePath);
        const current = loadCurrent(currentPath);

        const results = compareMetrics(baseline, current, threshold);

        if (results.length === 0) {
            console.log('⚠️  No common metrics found between baseline and current results');
            process.exit(1);
        }

        const allPassed = printReport(results);

        if (allPassed) {
            console.log('✅ All performance tests passed!');
            process.exit(0);
        } else {
            console.log('❌ Performance regression detected!');
            console.log('');
            console.log('This PR will be blocked due to performance degradation.');
            console.log('Please investigate and optimize the changes.');
            process.exit(1);
        }
    } catch (error) {
        console.error(`❌ Error: ${error}`);
        process.exit(1);
    }
};

main();
