import { execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';

export interface CodegenOptions {
  input?: string;
  output?: string;
}

/**
 * Generate TypeScript bindings from Rust exports
 */
export async function codegenCommand(options: CodegenOptions): Promise<void> {
  const spinner = ora();
  const outputDir = options.output || './src/api';

  try {
    console.log(chalk.cyan('\n📝 Generating TypeScript bindings...\n'));

    spinner.start(`Generating bindings to ${outputDir}...`);

    try {
      let cmd = 'zap-codegen';

      if (options.output) {
        cmd += ` --output ${options.output}`;
      }

      if (options.input) {
        cmd += ` --input ${options.input}`;
      }

      execSync(cmd, {
        stdio: 'pipe',
      });

      spinner.succeed('TypeScript bindings generated');
    } catch (error) {
      spinner.fail('Codegen failed');
      console.error(
        chalk.red(
          '\nMake sure zap-codegen is installed:\n  npm install -g @zapjs/codegen\n'
        )
      );
      process.exit(1);
    }

    console.log(chalk.green('\n✓ Codegen complete!\n'));
    console.log(chalk.gray(`Generated files in: ${outputDir}\n`));
  } catch (error) {
    spinner.fail('Codegen failed');
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
    }
    process.exit(1);
  }
}
