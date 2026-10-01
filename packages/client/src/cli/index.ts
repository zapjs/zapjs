#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { newCommand } from './commands/new.js';
import { devCommand } from './commands/dev.js';
import { buildCommand } from './commands/build.js';
import { previewCommand } from './commands/preview.js';
import { routesCommand } from './commands/routes.js';

const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const program = new Command().name('zap').description('ZapJS — integrated React framework').version(version);
program.command('new <directory>').description('Create a React application')
  .option('--native', 'Include an in-process Rust compute module')
  .option('--no-install', 'Skip dependency installation').option('--no-git', 'Skip Git initialization')
  .action(newCommand);
program.command('dev').description('Develop pages, server functions, and native modules')
  .option('-p, --port <port>', 'HTTP port', '3000').option('--host <host>', 'Bind address', '127.0.0.1')
  .action(devCommand);
program.command('build').description('Compile one application for managed deployment')
  .option('--adapter <adapter>', 'Deployment adapter (vercel|node)', 'vercel')
  .option('--target <triple>', 'Rust target triple for native modules').action(buildCommand);
program.command('preview').description('Inspect the built application locally')
  .option('-p, --port <port>', 'HTTP port', '3000').option('--host <host>', 'Bind address', '127.0.0.1')
  .action(previewCommand);
program.command('routes').description('Inspect the authoritative application route graph')
  .option('--json', 'Output the complete graph').action(routesCommand);
program.parseAsync().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
