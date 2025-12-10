import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { findAvailablePort } from '../utils/port-finder';
/**
 * Run production server
 */
export async function serveCommand(options) {
    const spinner = ora();
    const port = parseInt(options.port || '3000');
    const host = options.host || '127.0.0.1';
    try {
        console.log(chalk.cyan('\n🚀 Starting ZapRS production server...\n'));
        // Find available port
        spinner.start(`Checking if port ${port} is available...`);
        const availablePort = await findAvailablePort(port);
        if (availablePort !== port) {
            console.log(chalk.yellow(`\nPort ${port} is in use, using port ${availablePort} instead\n`));
        }
        spinner.succeed(`Server will run on http://${host}:${availablePort}`);
        // Start the server
        spinner.start('Starting server...');
        // Try to find and run the Rust binary
        const binPath = './target/release/zap';
        const proc = spawn(binPath, [], {
            stdio: 'inherit',
            env: {
                ...process.env,
                PORT: availablePort.toString(),
                HOST: host,
            },
        });
        spinner.succeed('Server started');
        console.log(chalk.green('\n✓ Server running!\n'));
        console.log(chalk.cyan(`  ➜ http://${host}:${availablePort}\n`));
        console.log(chalk.gray('Press Ctrl+C to stop\n'));
        process.on('SIGINT', () => {
            console.log(chalk.yellow('\nShutting down...\n'));
            proc.kill();
            process.exit(0);
        });
    }
    catch (error) {
        spinner.fail('Failed to start server');
        if (error instanceof Error) {
            console.error(chalk.red(`\nError: ${error.message}\n`));
        }
        process.exit(1);
    }
}
//# sourceMappingURL=serve.js.map