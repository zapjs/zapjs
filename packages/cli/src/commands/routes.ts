import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

export interface RoutesOptions {
  routesDir?: string;
  output?: string;
  json?: boolean;
}

/**
 * Scan routes and generate route tree
 */
export async function routesCommand(options: RoutesOptions): Promise<void> {
  const spinner = ora();

  try {
    const projectDir = process.cwd();
    const routesDir = resolve(options.routesDir || join(projectDir, 'routes'));
    const outputDir = resolve(options.output || join(projectDir, 'src', 'generated'));

    console.log(chalk.cyan('\n⚡ ZapJS Route Scanner\n'));

    // Check if routes directory exists
    if (!existsSync(routesDir)) {
      console.log(chalk.yellow('No routes directory found.'));
      console.log(chalk.gray(`Expected: ${routesDir}`));
      console.log(chalk.gray('\nCreate a routes/ directory with your route files to get started.'));
      console.log(chalk.gray('\nTanStack-style conventions:'));
      console.log(chalk.gray('  routes/index.tsx          → /'));
      console.log(chalk.gray('  routes/about.tsx          → /about'));
      console.log(chalk.gray('  routes/$postId.tsx        → /:postId'));
      console.log(chalk.gray('  routes/posts.$id.tsx      → /posts/:id'));
      console.log(chalk.gray('  routes/api/users.ts       → /api/users'));
      console.log(chalk.gray('  routes/_layout.tsx        → Layout wrapper'));
      console.log(chalk.gray('  routes/__root.tsx         → Root layout\n'));
      return;
    }

    // Try to load the router package
    spinner.start('Loading route scanner...');

    let router: {
      scanRoutes: (dir: string) => {
        routes: Array<{ urlPath: string; relativePath: string; params: Array<{ name: string }>; isIndex: boolean }>;
        apiRoutes: Array<{ urlPath: string; relativePath: string; params: Array<{ name: string }>; methods?: string[]; isIndex: boolean }>;
        root: unknown;
        layouts: unknown[];
      };
      generateRouteTree: (opts: { outputDir: string; routeTree: unknown }) => void;
    };

    try {
      // Dynamic import using variable to prevent TypeScript from resolving
      const moduleName = '@zapjs/router';
      router = await (Function('moduleName', 'return import(moduleName)')(moduleName));
    } catch {
      spinner.fail('@zapjs/router not found');
      console.log(chalk.yellow('\nInstall the router package:'));
      console.log(chalk.cyan('  npm install @zapjs/router\n'));
      return;
    }

    spinner.succeed('Route scanner loaded');

    // Scan routes
    spinner.start(`Scanning ${routesDir}...`);
    const tree = router.scanRoutes(routesDir);
    spinner.succeed('Routes scanned');

    // Output JSON if requested
    if (options.json) {
      console.log(JSON.stringify(tree, null, 2));
      return;
    }

    // Print route summary
    console.log(chalk.white('\n  Page Routes:'));
    if (tree.routes.length === 0) {
      console.log(chalk.gray('    (none)'));
    } else {
      for (const route of tree.routes) {
        const params = route.params.length > 0
          ? chalk.gray(` [${route.params.map(p => p.name).join(', ')}]`)
          : '';
        const index = route.isIndex ? chalk.gray(' (index)') : '';
        console.log(chalk.cyan(`    ${route.urlPath}`) + params + index);
        console.log(chalk.gray(`      → ${route.relativePath}`));
      }
    }

    console.log(chalk.white('\n  API Routes:'));
    if (tree.apiRoutes.length === 0) {
      console.log(chalk.gray('    (none)'));
    } else {
      for (const route of tree.apiRoutes) {
        const params = route.params.length > 0
          ? chalk.gray(` [${route.params.map(p => p.name).join(', ')}]`)
          : '';
        const methods = route.methods
          ? chalk.gray(` (${route.methods.join(', ')})`)
          : '';
        console.log(chalk.green(`    ${route.urlPath}`) + params + methods);
        console.log(chalk.gray(`      → ${route.relativePath}`));
      }
    }

    // Generate route tree files
    spinner.start('Generating route tree...');

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    router.generateRouteTree({
      outputDir,
      routeTree: tree,
    });

    spinner.succeed('Route tree generated');

    // Summary
    console.log(chalk.green(`\n✓ Found ${tree.routes.length} page routes, ${tree.apiRoutes.length} API routes`));
    console.log(chalk.gray(`  Output: ${outputDir}\n`));

  } catch (error) {
    spinner.fail('Route scanning failed');
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
    }
    process.exit(1);
  }
}
