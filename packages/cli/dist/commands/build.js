import { execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { ensureDirSync } from 'fs-extra';
/**
 * Build for production
 */
export async function buildCommand(options) {
    const spinner = ora();
    const outputDir = options.output || './dist';
    try {
        console.log(chalk.cyan('\n🔨 Building ZapRS project...\n'));
        // Create output directory
        ensureDirSync(outputDir);
        // Build Rust binary
        spinner.start('Building Rust backend...');
        try {
            const rustArgs = options.release
                ? ['--release']
                : [];
            execSync(`cargo build ${rustArgs.join(' ')} --bin zap`, {
                cwd: process.cwd(),
                stdio: 'inherit',
            });
            spinner.succeed('Rust backend built');
        }
        catch (error) {
            spinner.fail('Rust build failed');
            process.exit(1);
        }
        // Build TypeScript/React frontend
        spinner.start('Building React frontend...');
        try {
            execSync('npm run build', {
                cwd: process.cwd(),
                stdio: 'inherit',
            });
            spinner.succeed('React frontend built');
        }
        catch (error) {
            spinner.warn('React build skipped (not configured)');
        }
        // Generate TypeScript bindings
        spinner.start('Generating TypeScript bindings...');
        try {
            execSync('zap-codegen --output ./src/api', {
                cwd: process.cwd(),
                stdio: 'pipe',
            });
            spinner.succeed('TypeScript bindings generated');
        }
        catch (error) {
            spinner.warn('Codegen skipped');
        }
        console.log(chalk.green('\n✓ Build complete!\n'));
        console.log(chalk.gray(`Output directory: ${outputDir}\n`));
    }
    catch (error) {
        spinner.fail('Build failed');
        if (error instanceof Error) {
            console.error(chalk.red(`\nError: ${error.message}\n`));
        }
        process.exit(1);
    }
}
//# sourceMappingURL=build.js.map