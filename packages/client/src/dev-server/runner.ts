import { startDevelopment } from './server.js';

const options = JSON.parse(process.argv[2] || '{}');
startDevelopment(options.root, options).catch(error => {
  console.error('[zap] Development startup failed:', error);
  process.exitCode = 1;
});
