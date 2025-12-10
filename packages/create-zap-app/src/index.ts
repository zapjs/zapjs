#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { ensureDirSync, writeFileSync } from 'fs-extra';
import { join, resolve } from 'path';

interface CreateOptions {
  template?: string;
  skipInstall?: boolean;
  skipGit?: boolean;
  packageManager?: 'npm' | 'pnpm' | 'bun';
}

const program = new Command();

program
  .name('create-zap-app')
  .description('Create a new ZapJS application')
  .version('0.1.0')
  .argument('[name]', 'Project name')
  .option('-t, --template <template>', 'Template to use (basic|fullstack)', 'fullstack')
  .option('--skip-install', 'Skip package installation')
  .option('--skip-git', 'Skip git initialization')
  .option('--pm <manager>', 'Package manager (npm|pnpm|bun)', 'npm')
  .action(async (name: string | undefined, options: CreateOptions) => {
    await createApp(name, options);
  });

program.parse();

async function createApp(name: string | undefined, options: CreateOptions): Promise<void> {
  console.log(chalk.cyan('\n⚡ Create ZapJS App\n'));

  // Get project name
  let projectName = name;
  if (!projectName) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Project name:',
        default: 'my-zap-app',
        validate: (input: string) => {
          if (!input.trim()) return 'Project name is required';
          if (!/^[a-z0-9-_]+$/i.test(input)) return 'Project name can only contain letters, numbers, hyphens, and underscores';
          return true;
        },
      },
    ]);
    projectName = answers.name;
  }

  const projectDir = resolve(process.cwd(), projectName!);
  const spinner = ora();

  // Check if directory exists
  if (existsSync(projectDir)) {
    console.error(chalk.red(`\nError: Directory "${projectName}" already exists.\n`));
    process.exit(1);
  }

  // Get template choice
  let template = options.template;
  if (!template || !['basic', 'fullstack'].includes(template)) {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'template',
        message: 'Choose a template:',
        choices: [
          { name: 'Fullstack (React + Rust + File Routing)', value: 'fullstack' },
          { name: 'Basic (Minimal Rust API)', value: 'basic' },
        ],
        default: 'fullstack',
      },
    ]);
    template = answers.template;
  }

  // Get package manager
  let packageManager = options.packageManager || 'npm';
  if (!options.packageManager) {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'pm',
        message: 'Package manager:',
        choices: [
          { name: 'npm', value: 'npm' },
          { name: 'pnpm', value: 'pnpm' },
          { name: 'bun', value: 'bun' },
        ],
        default: 'npm',
      },
    ]);
    packageManager = answers.pm;
  }

  try {
    // Create project directory
    spinner.start('Creating project directory...');
    ensureDirSync(projectDir);
    spinner.succeed('Project directory created');

    // Create project structure
    spinner.start(`Scaffolding ${template} project...`);
    createProjectStructure(projectDir, projectName!, template!);
    spinner.succeed('Project scaffolded');

    // Install dependencies
    if (!options.skipInstall) {
      spinner.start(`Installing dependencies with ${packageManager}...`);
      const installCmd = packageManager === 'npm' ? 'npm install' :
                        packageManager === 'pnpm' ? 'pnpm install' : 'bun install';
      try {
        execSync(installCmd, { cwd: projectDir, stdio: 'pipe' });
        spinner.succeed('Dependencies installed');
      } catch {
        spinner.warn(`Failed to install dependencies. Run "${installCmd}" manually.`);
      }
    }

    // Initialize git
    if (!options.skipGit) {
      spinner.start('Initializing git repository...');
      try {
        execSync('git init', { cwd: projectDir, stdio: 'pipe' });
        execSync('git add .', { cwd: projectDir, stdio: 'pipe' });
        execSync('git commit -m "Initial commit"', { cwd: projectDir, stdio: 'pipe' });
        spinner.succeed('Git repository initialized');
      } catch {
        spinner.warn('Git initialization skipped');
      }
    }

    // Success message
    console.log(chalk.green(`\n✓ Project ${chalk.bold(projectName)} created successfully!\n`));

    console.log(chalk.bold('Next steps:'));
    console.log(chalk.cyan(`  cd ${projectName}`));
    if (options.skipInstall) {
      console.log(chalk.cyan(`  ${packageManager} install`));
    }
    console.log(chalk.cyan('  cargo build --release'));
    console.log(chalk.cyan('  zap dev'));
    console.log();

    console.log(chalk.gray('Happy coding! ⚡\n'));

  } catch (error) {
    spinner.fail('Project creation failed');
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
    }
    process.exit(1);
  }
}

function createProjectStructure(projectDir: string, projectName: string, template: string): void {
  // Create directories
  const dirs = [
    'server/src',
    'routes',
    'routes/api',
    'src',
    'src/generated',
  ];

  for (const dir of dirs) {
    ensureDirSync(join(projectDir, dir));
  }

  // Create server/src/main.rs
  const mainRs = `use zap::Zap;

#[tokio::main]
async fn main() {
    let mut app = Zap::new()
        .port(3000)
        .hostname("127.0.0.1")
        .cors()
        .logging()
        .use_file_routing();

    if let Err(e) = app.listen().await {
        eprintln!("Server error: {}", e);
        std::process::exit(1);
    }
}
`;

  // Create routes/__root.tsx
  const rootTsx = `import React from 'react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ZapJS App</title>
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
`;

  // Create routes/index.tsx
  const indexRoute = `export default function HomePage() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
      <h1 style={{ color: '#6366f1' }}>Welcome to ZapJS ⚡</h1>
      <p>Fullstack Rust + React Framework</p>

      <h2>Getting Started</h2>
      <ul>
        <li>Edit <code>routes/index.tsx</code> to change this page</li>
        <li>Add new routes in the <code>routes/</code> directory</li>
        <li>API routes go in <code>routes/api/</code></li>
      </ul>

      <h2>TanStack-Style Routing</h2>
      <pre style={{ background: '#f3f4f6', padding: '1rem', borderRadius: '0.5rem', overflow: 'auto' }}>
{${'`'}routes/index.tsx       → /
routes/about.tsx       → /about
routes/$postId.tsx     → /:postId
routes/api/users.ts    → /api/users
routes/api/users.$id.ts → /api/users/:id${'`'}}
      </pre>
    </div>
  );
}
`;

  // Create routes/api/hello.ts
  const helloApi = `export const GET = async () => {
  return {
    message: 'Hello from ZapJS!',
    timestamp: new Date().toISOString(),
  };
};

export const POST = async ({ request }: { request: Request }) => {
  const body = await request.json();
  return {
    received: body,
    message: 'Data received successfully',
  };
};
`;

  // Create routes/api/users.$id.ts
  const usersApi = `export const GET = async ({ params }: { params: { id: string } }) => {
  return {
    id: params.id,
    name: \`User \${params.id}\`,
    email: \`user\${params.id}@example.com\`,
  };
};
`;

  // Create package.json
  const packageJson = {
    name: projectName,
    version: '0.1.0',
    type: 'module',
    scripts: {
      'dev': 'zap dev',
      'build': 'zap build',
      'serve': 'zap serve',
      'routes': 'zap routes',
    },
    dependencies: {
      'react': '^18.0.0',
      'react-dom': '^18.0.0',
      '@zapjs/runtime': '^0.1.0',
      '@zapjs/router': '^0.1.0',
    },
    devDependencies: {
      '@types/react': '^18.0.0',
      '@types/react-dom': '^18.0.0',
      '@zapjs/cli': '^0.1.0',
      'typescript': '^5.0.0',
      'vite': '^5.0.0',
    },
  };

  // Create Cargo.toml
  const cargoToml = `[package]
name = "${projectName}"
version = "0.1.0"
edition = "2021"

[dependencies]
zap = { path = "../../packages/server" }
tokio = { version = "1.0", features = ["full"] }
serde_json = "1.0"
`;

  // Create zap.config.ts
  const zapConfig = `export default {
  server: {
    port: 3000,
    hostname: '127.0.0.1',
  },
  dev: {
    apiPort: 3000,
    clientPort: 5173,
    watchRust: true,
    watchTypeScript: true,
    watchRoutes: true,
    open: true,
  },
  routing: {
    dir: './routes',
    style: 'tanstack',
  },
};
`;

  // Create tsconfig.json
  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      strict: true,
      noEmit: true,
      jsx: 'react-jsx',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
    },
    include: ['routes', 'src'],
  };

  // Create .gitignore
  const gitignore = `# Dependencies
node_modules/
package-lock.json
pnpm-lock.yaml
bun.lockb

# Build output
/dist
/target
/server/target

# Generated
src/generated/

# Rust
Cargo.lock

# IDE
.vscode/
.idea/
*.swp
*.swo

# Environment
.env
.env.local
.env.*.local

# Logs
*.log
npm-debug.log*
`;

  // Create vite.config.ts
  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
`;

  // Write all files
  writeFileSync(join(projectDir, 'server/src/main.rs'), mainRs);
  writeFileSync(join(projectDir, 'routes/__root.tsx'), rootTsx);
  writeFileSync(join(projectDir, 'routes/index.tsx'), indexRoute);
  writeFileSync(join(projectDir, 'routes/api/hello.ts'), helloApi);
  writeFileSync(join(projectDir, 'routes/api/users.$id.ts'), usersApi);
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify(packageJson, null, 2));
  writeFileSync(join(projectDir, 'Cargo.toml'), cargoToml);
  writeFileSync(join(projectDir, 'zap.config.ts'), zapConfig);
  writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  writeFileSync(join(projectDir, '.gitignore'), gitignore);
  writeFileSync(join(projectDir, 'vite.config.ts'), viteConfig);

  // Create README.md
  const readme = `# ${projectName}

A ZapJS fullstack application.

## Getting Started

\`\`\`bash
# Install dependencies
npm install

# Build Rust backend
cargo build --release

# Start development server
zap dev
\`\`\`

## Project Structure

\`\`\`
${projectName}/
├── routes/              # File-based routing (TanStack style)
│   ├── __root.tsx       # Root layout
│   ├── index.tsx        # Home page (/)
│   └── api/             # API routes
│       └── hello.ts     # /api/hello
├── server/              # Rust backend
│   └── src/
│       └── main.rs
├── src/                 # Shared TypeScript
│   └── generated/       # Auto-generated types
├── package.json
├── Cargo.toml
└── zap.config.ts
\`\`\`

## Commands

- \`zap dev\` - Start dev server with hot reload
- \`zap build\` - Build for production
- \`zap serve\` - Run production server
- \`zap routes\` - Scan and display routes
`;

  writeFileSync(join(projectDir, 'README.md'), readme);
}
