import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { cliLogger } from '../utils/logger.js';

export interface NewOptions { install?: boolean; git?: boolean; native?: boolean; }

/** A generated app uses the same graph and runtime as every other Zap application. */
export async function newCommand(directory: string, options: NewOptions = {}): Promise<void> {
  const root = resolve(directory);
  if (existsSync(root)) throw new Error(`Directory already exists: ${root}`);
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!name || !/^[a-z0-9]/.test(name)) throw new Error('Use a project directory beginning with a letter or digit');
  const framework = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('package.json', JSON.stringify({
    name, version: '0.0.0', private: true, type: 'module', engines: { node: '>=22.12.0' },
    scripts: { dev: 'zap dev', build: 'zap build', preview: 'zap preview', routes: 'zap routes' },
    dependencies: {
      '@zap-js/client': framework.version,
      react: framework.dependencies.react, 'react-dom': framework.dependencies['react-dom'],
    },
    devDependencies: { typescript: '^5.9.0', '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0', '@types/node': '^22.0.0' },
  }, null, 2) + '\n');
  write('tsconfig.json', JSON.stringify({
    compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], jsx: 'react-jsx',
      module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true,
      esModuleInterop: true, allowImportingTsExtensions: true },
    include: ['app/**/*.ts', 'app/**/*.tsx', '.zap/types/**/*.d.ts'],
  }, null, 2) + '\n');
  write('app/layout.tsx', `import type { ReactNode } from 'react';\nimport './styles.css';\nexport default function Layout({ children }: { children: ReactNode }) {\n  return <html lang="en"><head><title>ZapJS</title></head><body>{children}</body></html>;\n}\n`);
  write('app/page.tsx', `import { Link } from '@zap-js/client';\nimport Counter from './counter';\nexport default async function Page() {\n  return <main><p>ZapJS</p><h1>Your application starts here.</h1><p>This page renders on the server. The counter hydrates in your browser.</p><Counter /><p><Link href="/about">About this application</Link></p></main>;\n}\n`);
  write('app/counter.tsx', `'use client';\nimport { useState } from 'react';\nexport default function Counter() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(value => value + 1)}>Count: {count}</button>;\n}\n`);
  write('app/about/page.tsx', `import { Link } from '@zap-js/client';\nexport default function About() { return <main><h1>One application.</h1><p>Pages, components, and route handlers share one build.</p><Link href="/">Back home</Link></main>; }\n`);
  write('app/api/health/route.ts', `export function GET() { return Response.json({ status: 'ok' }); }\n`);
  write('app/styles.css', `:root{font-family:system-ui,sans-serif;color:#202020;background:#faf9f6}body{margin:0}main{max-width:48rem;margin:12vh auto;padding:2rem}h1{font-size:clamp(2rem,6vw,4rem);letter-spacing:-.05em;line-height:1.05}p{line-height:1.6}button{font:inherit;padding:.75rem 1.25rem;border:1px solid #202020;border-radius:.5rem;background:white;cursor:pointer}a{color:inherit}\n`);
  write('.gitignore', 'node_modules/\n.zap/\n.vercel/\n.env*\n!.env.example\n');
  write('README.md', `# ${name}\n\nRun \`npm run dev\` to develop this application. Pages and nested layouts live in \`app/\`; API handlers export HTTP methods from \`route.ts\` and use Web Request/Response. Interactive components use \`'use client'\`.\n\n\`npm run build\` generates \`.vercel/output\` for Vercel's Build Output API. Deploy that artifact with \`vercel deploy --prebuilt\`. \`npm run preview\` inspects the compiled application locally. No separately managed backend is required.\n\nFor a portable local build use \`zap build --adapter node\`. Native Rust modules are optional and belong in \`native/\`; managed builds require a matching Linux target.\n`);
  if (options.native) {
    write('native/Cargo.toml', `[package]\nname = "${name}-native"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[lib]\ncrate-type = ["cdylib"]\n[dependencies]\nnapi = { version = "=3.13.0", default-features = false, features = ["napi8", "tokio_rt", "dyn-symbols"] }\nnapi-derive = "=3.6.9"\nzap-native = { path = "../node_modules/@zap-js/client/dist/native/rust" }\n[build-dependencies]\nnapi-build = "=2.5.0"\n`);
    write('native/build.rs', 'fn main() { napi_build::setup(); }\n');
    write('native/src/lib.rs', `use napi_derive::napi;\n#[napi(strict)]\npub async fn sum_numbers(values: Vec<f64>) -> napi::Result<u32> {\n    if values.iter().any(|value| !value.is_finite() || value.fract() != 0.0 || *value < 0.0 || *value > u32::MAX as f64) {\n        return Err(napi::Error::from_reason("Values must be unsigned 32-bit integers"));\n    }\n    let result = zap_native::compute(move |token| {\n        let mut total = 0u32;\n        for value in values {\n            token.check()?;\n            let Some(next) = total.checked_add(value as u32) else { return Ok(None); };\n            total = next;\n        }\n        Ok(Some(total))\n    }).await.map_err(|error| napi::Error::from_reason(error.to_string()))?;\n    result.ok_or_else(|| napi::Error::from_reason("Sum exceeds unsigned 32-bit range"))\n}\n`);
    write('app/api/native/route.ts', `import { sumNumbers } from 'zap:native';\nexport async function GET() { return Response.json({ sum: await sumNumbers([19, 23]) }); }\n`);
    write('rust-toolchain.toml', '[toolchain]\nchannel = "1.92.0"\nprofile = "minimal"\n');
    write('vercel.json', JSON.stringify({
      $schema: 'https://openapi.vercel.sh/vercel.json', framework: null,
      installCommand: 'sh scripts/install.sh', buildCommand: 'sh scripts/build.sh',
    }, null, 2) + '\n');
    write('.vercelignore', 'node_modules\n.zap\nnative/target\n.vercel\n');
    write('scripts/install.sh', `#!/bin/sh
set -eu
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
if ! command -v rustup >/dev/null 2>&1; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$installer"
  sh "$installer" -y --profile minimal --default-toolchain 1.92.0 --no-modify-path
  . "$HOME/.cargo/env"
else
  rustup toolchain install 1.92.0 --profile minimal
fi
rustc --version
npm ci --no-audit --no-fund
`);
    write('scripts/build.sh', `#!/bin/sh
set -eu
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
rustc --version
npm run build
`);
    write('README.md', `# ${name}\n\nRun \`npm install\` and \`cargo generate-lockfile --manifest-path native/Cargo.toml\` if you created this application with \`--no-install\`. Install Rust using https://rustup.rs if needed; the toolchain is pinned in \`rust-toolchain.toml\`. Commit both package-lock.json and native/Cargo.lock.\n\nRun \`npm run dev\` to develop. Rust edits rebuild the in-process addon and restart the local runtime. \`/api/native\` calls the typed Rust example. Pages and nested layouts live in \`app/\`; interactive components use \`'use client'\`.\n\nFor local production verification run \`npx zap build --adapter node\` and \`npm run preview\`. Deploy this source directory with \`vercel deploy\`: the included install script provisions Rust 1.92.0 and locked npm dependencies, then the managed Linux build compiles the addon and emits Vercel's function artifact. Keep the default x86_64 function architecture. Native artifacts must match the deployment OS and architecture; do not upload a macOS build as a Linux prebuilt deployment.\n`);
    write('native/README.md', 'The SDK is shipped inside the installed framework package. Export typed functions with napi-rs and use zap_native::compute for bounded CPU work. The example validates unsigned 32-bit inputs and rejects overflow. Commit native/Cargo.lock; the managed install/build scripts provision the pinned Rust toolchain and build for Linux GNU. Native work executes inside the Node process, so cancellation requires cooperative token checks.\n');
  }
  if (options.install !== false) {
    execFileSync('npm', ['install'], { cwd: root, stdio: 'inherit' });
    if (options.native) execFileSync('cargo', ['generate-lockfile', '--manifest-path', 'native/Cargo.toml'], { cwd: root, stdio: 'inherit' });
  }
  if (options.git !== false) execFileSync('git', ['init'], { cwd: root, stdio: 'inherit' });
  cliLogger.success(`Created ${root}`);
  cliLogger.info(`Run cd ${directory}${options.install === false ? ' && npm install' : ''} && npm run dev`);
}
