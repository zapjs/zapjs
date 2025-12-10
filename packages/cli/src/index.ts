#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { newCommand } from './commands/new';
import { devCommand } from './commands/dev';
import { buildCommand } from './commands/build';
import { serveCommand } from './commands/serve';
import { codegenCommand } from './commands/codegen';

const program = new Command();

program
  .name('zap')
  .description('ZapRS - Fullstack Rust + React Framework')
  .version('0.1.0', '-v, --version')
  .helpOption('-h, --help');

// Register commands
program
  .command('new <name>')
  .description('Create a new ZapRS project')
  .option('-t, --template <template>', 'Template to use (basic|fullstack)', 'basic')
  .option('--no-install', 'Skip npm install')
  .option('--no-git', 'Skip git initialization')
  .action((name, options) => newCommand(name, options));

program
  .command('dev')
  .description('Start development server with hot reload')
  .option('-p, --port <port>', 'API server port', '3000')
  .option('--vite-port <port>', 'Vite dev server port', '5173')
  .option('--no-open', 'Do not open browser')
  .option('-l, --log-level <level>', 'Log level (debug|info|warn|error)', 'info')
  .option('--release', 'Build in release mode')
  .option('--skip-build', 'Skip initial Rust build')
  .action((options) => devCommand(options));

program
  .command('build')
  .description('Build for production')
  .option('--release', 'Build optimized release build', true)
  .option('-o, --output <dir>', 'Output directory', './dist')
  .action((options) => buildCommand(options));

program
  .command('serve')
  .description('Run production server')
  .option('-p, --port <port>', 'Port to run on', '3000')
  .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
  .action((options) => serveCommand(options));

program
  .command('codegen')
  .description('Generate TypeScript bindings from Rust exports')
  .option('-i, --input <file>', 'Input metadata JSON file')
  .option('-o, --output <dir>', 'Output directory', './src/api')
  .action((options) => codegenCommand(options));

// Handle unknown commands
program.on('command:*', () => {
  console.error(
    chalk.red(
      `\nError: Unknown command "${program.args[0]}".\n`
    )
  );
  program.outputHelp();
  process.exit(1);
});

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

program.parse();
