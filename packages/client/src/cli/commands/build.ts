import { createBuilder } from 'vite';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createZapConfig } from '../../compiler/config.js';
import { buildNative } from '../../native/build.js';
import { emitVercelOutput } from '../../adapters/vercel.js';
import { cliLogger } from '../utils/logger.js';

export interface BuildOptions { adapter?: 'vercel' | 'node'; target?: string; }

export async function buildCommand(options: BuildOptions = {}): Promise<void> {
  const root = process.cwd();
  const adapter = options.adapter || 'vercel';
  if (!['vercel', 'node'].includes(adapter)) throw new Error('Adapter must be vercel or node');
  const output = resolve(root, '.zap/output');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const native = await buildNative(root, {
    release: true, target: options.target || (adapter === 'vercel' ? 'x86_64-unknown-linux-gnu' : undefined),
    outDir: join(output, 'native'),
  });
  const config = createZapConfig(root, { command: 'build', outDir: output, nativeLoader: native?.loaderPath });
  const builder = await createBuilder(config);
  await builder.buildApp();
  const manifestPath = join(output, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (native) {
    manifest.native = { target: native.target, napiVersion: native.napiVersion, exports: native.exports };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  if (adapter === 'vercel') {
    const deployment = await emitVercelOutput(root, { nativeTarget: native?.target });
    cliLogger.success(`Managed deployment built: ${deployment}`);
    cliLogger.info('Deploy this artifact with vercel deploy --prebuilt.');
  } else cliLogger.success(`Application built: ${output}`);
}
