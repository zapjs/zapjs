import { execSync } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import fsExtra from 'fs-extra';
import { join, resolve } from 'path';
import ora from 'ora';

const { ensureDirSync, writeFileSync } = fsExtra;

export interface NewOptions {
  template: string;
  install?: boolean;
  git?: boolean;
}

/**
 * Create a new ZapRS project
 */
export async function newCommand(name: string, options: NewOptions): Promise<void> {
  if (!name || name.trim() === '') {
    console.error(chalk.red('Error: Project name is required'));
    process.exit(1);
  }

  const projectDir = resolve(process.cwd(), name);
  const spinner = ora();

  try {
    // Check if directory already exists
    try {
      const fs = await import('fs');
      if (fs.existsSync(projectDir)) {
        console.error(
          chalk.red(`\nError: Directory "${name}" already exists.\n`)
        );
        process.exit(1);
      }
    } catch (error) {
      // Directory doesn't exist, which is good
    }

    // Prompt for template if not specified
    let template = options.template;
    const templates = ['basic', 'fullstack'];

    if (!templates.includes(template)) {
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'template',
          message: 'Choose a template:',
          choices: templates.map((t) => ({
            name: t.charAt(0).toUpperCase() + t.slice(1),
            value: t,
          })),
          default: 'basic',
        },
      ]);
      template = answers.template;
    }

    // Create project directory
    spinner.start(`Creating project directory...`);
    ensureDirSync(projectDir);
    spinner.succeed('Project directory created');

    // Create project files
    spinner.start(`Creating ${template} project...`);
    createMinimalProject(projectDir, name, template);
    spinner.succeed('Project files created');

    // Install dependencies
    if (options.install !== false) {
      spinner.start('Installing dependencies...');
      try {
        execSync('npm install', { cwd: projectDir, stdio: 'pipe' });
        spinner.succeed('Dependencies installed');
      } catch (error) {
        spinner.warn('Note: npm install skipped. Run "npm install" manually.');
      }
    }

    // Initialize git
    if (options.git !== false) {
      spinner.start('Initializing git repository...');
      try {
        execSync('git init', { cwd: projectDir, stdio: 'pipe' });
        execSync('git add .', { cwd: projectDir, stdio: 'pipe' });
        execSync('git commit -m "Initial commit"', {
          cwd: projectDir,
          stdio: 'pipe',
        });
        spinner.succeed('Git repository initialized');
      } catch (error) {
        spinner.warn('Git initialization skipped');
      }
    }

    // Success message
    console.log(
      `\n${chalk.green('✓')} Project ${chalk.bold(name)} created successfully!\n`
    );

    // Next steps
    console.log(chalk.bold('Next steps:'));
    console.log(`  ${chalk.cyan(`cd ${name}`)}`);
    console.log(`  ${chalk.cyan('cargo build --release')}`);
    console.log(`  ${chalk.cyan('zap dev')}\n`);

    console.log(chalk.gray('Happy coding! 🚀\n'));
  } catch (error) {
    spinner.fail('Project creation failed');
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
    }
    process.exit(1);
  }
}

/**
 * Create a minimal project structure
 */
function createMinimalProject(
  projectDir: string,
  projectName: string,
  template: string
): void {
  // Create directory structure
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
        .logging();

    // Register your routes here
    app.get("/api/health", || {
        serde_json::json!({ "status": "ok" })
    });

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
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>Welcome to ZapJS</h1>
      <p>Fullstack Rust + React Framework</p>
      <p>
        Edit <code>routes/index.tsx</code> to get started.
      </p>
    </div>
  );
}
`;

  // Create routes/api/hello.ts
  const helloApi = `import { server } from '../../src/generated/server';

export const GET = async () => {
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
  const zapConfig = `import { defineConfig } from 'zap';

export default defineConfig({
  server: {
    port: 3000,
    hostname: '127.0.0.1',
  },
  dev: {
    apiPort: 3000,
    clientPort: 5173,
    watchRust: true,
    watchTypeScript: true,
    open: true,
  },
});
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
    include: ['client/src'],
    references: [{ path: './tsconfig.node.json' }],
  };

  // Write files
  writeFileSync(join(projectDir, 'server/src/main.rs'), mainRs);
  writeFileSync(join(projectDir, 'routes/__root.tsx'), rootTsx);
  writeFileSync(join(projectDir, 'routes/index.tsx'), indexRoute);
  writeFileSync(join(projectDir, 'routes/api/hello.ts'), helloApi);
  writeFileSync(join(projectDir, 'routes/api/users.$id.ts'), usersApi);
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify(packageJson, null, 2));
  writeFileSync(join(projectDir, 'Cargo.toml'), cargoToml);
  writeFileSync(join(projectDir, 'zap.config.ts'), zapConfig);
  writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

  // Create .gitignore
  const gitignore = `# Dependencies
node_modules/
package-lock.json

# Build output
/dist
/target
/server/target

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

# Logs
*.log
`;

  writeFileSync(join(projectDir, '.gitignore'), gitignore);
}
