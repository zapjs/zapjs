import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

export interface RoutesOptions {
  routesDir?: string;
  output?: string;
  json?: boolean;
  showCode?: boolean;
  verbose?: boolean;
}

/**
 * Extract handler code from a route file
 */
function extractHandlerCode(filePath: string, method?: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    
    if (method) {
      // Look for specific HTTP method handler
      const patterns = [
        // export const GET = ...
        new RegExp(`export\\s+(?:const|let|var)\\s+${method}\\s*=\\s*([^;]+)`, 's'),
        // export function GET() { ... }
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\([^)]*\\)\\s*{([^}]+)}`, 's'),
        // export async function GET() { ... }
        new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\([^)]*\\)\\s*{([^}]+)}`, 's'),
      ];
      
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match) {
          return match[0].trim();
        }
      }
    } else {
      // Look for default export (page component)
      const patterns = [
        // export default function Component() { ... }
        /export\s+default\s+(?:async\s+)?function\s+\w*\s*\([^)]*\)\s*{[^}]+}/s,
        // const Component = () => { ... }; export default Component;
        /(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|[^=]+)\s*=>\s*{[^}]+}.*export\s+default\s+\1/s,
        // export default () => { ... }
        /export\s+default\s+(?:\([^)]*\)|[^=]+)\s*=>\s*{[^}]+}/s,
      ];
      
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match) {
          // Limit to first 10 lines for preview
          const lines = match[0].split('\n').slice(0, 10);
          if (lines.length >= 10) {
            lines.push('  // ...');
          }
          return lines.join('\n');
        }
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Enhanced route scanner that shows handler logic
 */
export async function routesCommand(options: RoutesOptions): Promise<void> {
  const spinner = ora();

  try {
    const projectDir = process.cwd();
    const routesDir = resolve(options.routesDir || join(projectDir, 'routes'));
    const outputDir = resolve(options.output || join(projectDir, 'src', 'generated'));
    const showCode = options.showCode !== false; // Default to true

    console.log(chalk.cyan('\n⚡ ZapJS Route Scanner\n'));

    // Check if routes directory exists
    if (!existsSync(routesDir)) {
      console.log(chalk.yellow('No routes directory found.'));
      console.log(chalk.gray(`Expected: ${routesDir}`));
      console.log(chalk.gray('\nCreate a routes/ directory with your route files to get started.'));
      console.log(chalk.gray('\nNext.js-style conventions:'));
      console.log(chalk.gray('  routes/index.tsx          → /'));
      console.log(chalk.gray('  routes/about.tsx          → /about'));
      console.log(chalk.gray('  routes/[postId].tsx       → /:postId'));
      console.log(chalk.gray('  routes/posts/[id].tsx     → /posts/:id'));
      console.log(chalk.gray('  routes/api/users.ts       → /api/users'));
      console.log(chalk.gray('  routes/_layout.tsx        → Layout wrapper'));
      console.log(chalk.gray('  routes/__root.tsx         → Root layout\n'));
      return;
    }

    // Try to load the router package
    spinner.start('Loading route scanner...');

    let router: any;

    try {
      // Try internal path first
      const internalPath = join(__dirname, '../../../router/src/index.js');
      if (existsSync(internalPath)) {
        router = await import(internalPath);
      } else {
        // Try relative path within client package
        const clientInternalPath = join(__dirname, '../../router/src/index.js');
        router = await import(clientInternalPath);
      }
    } catch (error) {
      spinner.fail('Route scanner not found');
      console.error('Error:', error);
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

    // Print route summary with code
    console.log(chalk.white('\n📁 Page Routes:\n'));
    if (tree.routes.length === 0) {
      console.log(chalk.gray('    (none)'));
    } else {
      for (const route of tree.routes) {
        const params = route.params.length > 0
          ? chalk.gray(` [${route.params.map(p => p.name).join(', ')}]`)
          : '';
        const index = route.isIndex ? chalk.gray(' (index)') : '';
        
        console.log(chalk.cyan(`  ${route.urlPath}`) + params + index);
        console.log(chalk.gray(`    File: ${route.relativePath}`));
        
        if (showCode) {
          const code = extractHandlerCode(route.filePath);
          if (code && options.verbose) {
            console.log(chalk.gray('    Handler:'));
            const codeLines = code.split('\n').map(line => '      ' + line);
            console.log(chalk.gray(codeLines.join('\n')));
          }
        }
        
        // Show special exports
        const features = [];
        if (route.hasErrorComponent) features.push('error boundary');
        if (route.hasPendingComponent) features.push('loading state');
        if (route.hasMeta) features.push('meta tags');
        if (route.hasMiddleware) features.push('middleware');
        if (route.hasGenerateStaticParams) features.push('SSG');
        
        if (features.length > 0) {
          console.log(chalk.gray(`    Features: ${features.join(', ')}`));
        }
        
        console.log();
      }
    }

    console.log(chalk.white('\n🌐 API Routes:\n'));
    if (tree.apiRoutes.length === 0) {
      console.log(chalk.gray('    (none)'));
    } else {
      for (const route of tree.apiRoutes) {
        const params = route.params.length > 0
          ? chalk.gray(` [${route.params.map(p => p.name).join(', ')}]`)
          : '';
        const methods = route.methods
          ? chalk.green(` ${route.methods.join(' | ')}`)
          : '';
        
        console.log(chalk.green(`  ${route.urlPath}`) + params);
        console.log(chalk.gray(`    File: ${route.relativePath}`));
        console.log(chalk.gray(`    Methods:`) + methods);
        
        if (showCode && route.methods) {
          for (const method of route.methods) {
            const code = extractHandlerCode(route.filePath, method);
            if (code) {
              if (options.verbose) {
                console.log(chalk.gray(`    ${method} Handler:`));
                const codeLines = code.split('\n').map(line => '      ' + line);
                console.log(chalk.gray(codeLines.join('\n')));
              } else {
                // Just show first line
                const firstLine = code.split('\n')[0];
                console.log(chalk.gray(`    ${method}: ${firstLine.trim()}...`));
              }
            }
          }
        }
        
        // Show features
        const features = [];
        if (route.hasMiddleware) features.push('middleware');
        
        if (features.length > 0) {
          console.log(chalk.gray(`    Features: ${features.join(', ')}`));
        }
        
        console.log();
      }
    }

    // Show layouts
    if (tree.layouts && tree.layouts.length > 0) {
      console.log(chalk.white('\n📐 Layouts:\n'));
      for (const layout of tree.layouts) {
        console.log(chalk.magenta(`  ${layout.scopePath || '/'} (scope)`));
        console.log(chalk.gray(`    File: ${layout.relativePath}`));
        if (layout.parentLayout) {
          console.log(chalk.gray(`    Parent: ${layout.parentLayout}`));
        }
        console.log();
      }
    }

    // Show WebSocket routes
    if (tree.wsRoutes && tree.wsRoutes.length > 0) {
      console.log(chalk.white('\n🔌 WebSocket Routes:\n'));
      for (const route of tree.wsRoutes) {
        const params = route.params.length > 0
          ? chalk.gray(` [${route.params.map(p => p.name).join(', ')}]`)
          : '';
        
        console.log(chalk.yellow(`  ${route.urlPath}`) + params);
        console.log(chalk.gray(`    File: ${route.relativePath}`));
        console.log();
      }
    }

    // Generate route tree files if output is specified
    if (!options.json) {
      spinner.start('Generating route tree...');

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Use enhanced route tree generation if available
      if (router.generateEnhancedRouteTree) {
        router.generateEnhancedRouteTree({
          outputDir,
          routeTree: tree,
        });
      } else {
        router.generateRouteTree({
          outputDir,
          routeTree: tree,
        });
      }

      spinner.succeed('Route tree generated');

      // Summary
      const totalRoutes = tree.routes.length + tree.apiRoutes.length + (tree.wsRoutes?.length || 0);
      console.log(chalk.green(`\n✓ Found ${totalRoutes} total routes:`));
      console.log(chalk.gray(`  - ${tree.routes.length} page routes`));
      console.log(chalk.gray(`  - ${tree.apiRoutes.length} API routes`));
      if (tree.wsRoutes?.length) {
        console.log(chalk.gray(`  - ${tree.wsRoutes.length} WebSocket routes`));
      }
      if (tree.layouts?.length) {
        console.log(chalk.gray(`  - ${tree.layouts.length} layouts`));
      }
      console.log(chalk.gray(`\n  Output: ${outputDir}\n`));
    }

    // Tips
    if (!options.verbose && showCode) {
      console.log(chalk.gray('💡 Tip: Use --verbose flag to see full handler code\n'));
    }

  } catch (error) {
    spinner.fail('Route scanning failed');
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}\n`));
      if (options.verbose) {
        console.error(error.stack);
      }
    }
    process.exit(1);
  }
}