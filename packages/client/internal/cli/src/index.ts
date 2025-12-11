#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { newCommand } from './commands/new.js';
import { devCommand } from './commands/dev.js';
import { buildCommand } from './commands/build.js';
import { serveCommand } from './commands/serve.js';
import { codegenCommand } from './commands/codegen.js';
import { routesCommand } from './commands/routes.js';

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
  .option('--target <target>', 'Cross-compile target (e.g., x86_64-unknown-linux-gnu)')
  .option('--skip-frontend', 'Skip frontend build')
  .option('--skip-codegen', 'Skip TypeScript codegen')
  .action((options) => buildCommand(options));

program
  .command('serve')
  .description('Run production server')
  .option('-p, --port <port>', 'Port to run on')
  .option('--host <host>', 'Host to bind to')
  .option('-c, --config <path>', 'Path to config file')
  .option('-w, --workers <count>', 'Number of worker threads')
  .action((options) => serveCommand(options));

program
  .command('codegen')
  .description('Generate TypeScript bindings from Rust exports')
  .option('-i, --input <file>', 'Input metadata JSON file')
  .option('-o, --output <dir>', 'Output directory', './src/api')
  .action((options) => codegenCommand(options));

program
  .command('routes')
  .description('Scan routes directory and generate route tree')
  .option('-d, --routes-dir <dir>', 'Routes directory path')
  .option('-o, --output <dir>', 'Output directory for generated files')
  .option('--json', 'Output routes as JSON')
  .action((options) => routesCommand(options));

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
