import chalk from 'chalk';

/** Shared output for the supported CLI commands. */
export const cliLogger = {
  success(message: string): void {
    console.log(chalk.hex('#10b981')('✓'), chalk.white(message));
  },
  info(message: string): void {
    console.log(chalk.hex('#3b82f6')('ℹ'), chalk.white(message));
  },
};
