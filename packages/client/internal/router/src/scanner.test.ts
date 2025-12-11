/**
 * Tests for route scanner with Next.js style [param] conventions
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { RouteScanner, scanRoutes } from './scanner.js';

const TEST_DIR = join(process.cwd(), '.test-routes');

function createTestRoutes() {
  // Create test directory structure
  const dirs = [
    TEST_DIR,
    join(TEST_DIR, 'api'),
    join(TEST_DIR, 'posts'),
    join(TEST_DIR, 'blog'),
    join(TEST_DIR, '(group)'),
    join(TEST_DIR, '_private'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Create test route files with new [param] convention
  const files: Record<string, string> = {
    // Index routes
    'index.tsx': 'export default function Home() {}',
    'about.tsx': 'export default function About() {}',

    // Dynamic routes - Next.js style [param]
    '[id].tsx': 'export default function Item({ params }) { return params.id; }',
    '[slug].tsx': 'export default function Slug({ params }) { return params.slug; }',

    // Nested dynamic routes
    'posts/[postId].tsx': 'export default function Post({ params }) { return params.postId; }',
    'posts/index.tsx': 'export default function Posts() {}',

    // Catch-all routes - file is actually named with brackets
    'blog/[...slug].tsx': 'export default function Blog({ params }) { return params.slug; }',

    // Optional catch-all - double brackets
    'docs/[[...path]].tsx': 'export default function Docs({ params }) { return params.path; }',

    // API routes with dynamic params
    'api/users.[id].ts': `
      export const GET = async ({ params }) => ({ id: params.id });
      export const POST = async ({ params, body }) => ({ created: true });
    `,
    'api/index.ts': 'export const GET = async () => ({ status: "ok" });',

    // Route group (should not affect URL)
    '(group)/dashboard.tsx': 'export default function Dashboard() {}',

    // Private folder (should be excluded)
    '_private/secret.tsx': 'export default function Secret() {}',

    // Error component export
    'error-test.tsx': `
      export default function ErrorTest() {}
      export function errorComponent({ error }) { return <div>{error.message}</div>; }
    `,

    // SSG export
    'ssg-test.tsx': `
      export default function SsgTest({ params }) {}
      export async function generateStaticParams() {
        return [{ id: '1' }, { id: '2' }];
      }
    `,

    // Root layout
    '__root.tsx': `
      export default function RootLayout({ children }) {
        return <html><body>{children}</body></html>;
      }
    `,

    // Scoped layout
    'posts/_layout.tsx': `
      export default function PostsLayout({ children }) {
        return <div className="posts-layout">{children}</div>;
      }
    `,
  };

  // Create docs directory for optional catch-all
  mkdirSync(join(TEST_DIR, 'docs'), { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(TEST_DIR, filePath);
    const dir = join(fullPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content);
  }
}

function cleanupTestRoutes() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('RouteScanner with [param] convention', () => {
  beforeAll(() => {
    cleanupTestRoutes();
    createTestRoutes();
  });

  afterAll(() => {
    cleanupTestRoutes();
  });

  describe('Basic route scanning', () => {
    it('should scan index routes', () => {
      const tree = scanRoutes(TEST_DIR);
      const indexRoute = tree.routes.find(r => r.urlPath === '/');
      expect(indexRoute).toBeDefined();
      expect(indexRoute?.isIndex).toBe(true);
    });

    it('should scan static routes', () => {
      const tree = scanRoutes(TEST_DIR);
      const aboutRoute = tree.routes.find(r => r.urlPath === '/about');
      expect(aboutRoute).toBeDefined();
      expect(aboutRoute?.params).toHaveLength(0);
    });
  });

  describe('Dynamic routes with [param]', () => {
    it('should parse [id] as dynamic segment', () => {
      const tree = scanRoutes(TEST_DIR);
      const idRoute = tree.routes.find(r => r.urlPath === '/:id');
      expect(idRoute).toBeDefined();
      expect(idRoute?.params).toHaveLength(1);
      expect(idRoute?.params[0].name).toBe('id');
      expect(idRoute?.params[0].catchAll).toBe(false);
      expect(idRoute?.params[0].optional).toBe(false);
    });

    it('should parse nested [postId]', () => {
      const tree = scanRoutes(TEST_DIR);
      const postRoute = tree.routes.find(r => r.urlPath === '/posts/:postId');
      expect(postRoute).toBeDefined();
      expect(postRoute?.params).toHaveLength(1);
      expect(postRoute?.params[0].name).toBe('postId');
    });
  });

  describe('Catch-all routes', () => {
    it('should parse [...slug] as catch-all', () => {
      const tree = scanRoutes(TEST_DIR);
      const blogRoute = tree.routes.find(r => r.urlPath === '/blog/*slug');
      expect(blogRoute).toBeDefined();
      expect(blogRoute?.params).toHaveLength(1);
      expect(blogRoute?.params[0].name).toBe('slug');
      expect(blogRoute?.params[0].catchAll).toBe(true);
      expect(blogRoute?.params[0].optional).toBe(false);
    });

    it('should parse [[...path]] as optional catch-all', () => {
      const tree = scanRoutes(TEST_DIR);
      const docsRoute = tree.routes.find(r => r.urlPath === '/docs/*path?');
      expect(docsRoute).toBeDefined();
      expect(docsRoute?.params).toHaveLength(1);
      expect(docsRoute?.params[0].name).toBe('path');
      expect(docsRoute?.params[0].catchAll).toBe(true);
      expect(docsRoute?.params[0].optional).toBe(true);
    });
  });

  describe('API routes', () => {
    it('should detect API routes with [param]', () => {
      const tree = scanRoutes(TEST_DIR);
      const apiRoute = tree.apiRoutes.find(r => r.urlPath === '/api/users/:id');
      expect(apiRoute).toBeDefined();
      expect(apiRoute?.type).toBe('api');
      expect(apiRoute?.params).toHaveLength(1);
      expect(apiRoute?.params[0].name).toBe('id');
    });

    it('should detect HTTP method exports', () => {
      const tree = scanRoutes(TEST_DIR);
      const apiRoute = tree.apiRoutes.find(r => r.urlPath === '/api/users/:id');
      expect(apiRoute?.methods).toContain('GET');
      expect(apiRoute?.methods).toContain('POST');
    });
  });

  describe('Route groups and exclusions', () => {
    it('should scan routes in (group) without URL segment', () => {
      const tree = scanRoutes(TEST_DIR);
      const dashboardRoute = tree.routes.find(r => r.urlPath === '/dashboard');
      expect(dashboardRoute).toBeDefined();
    });

    it('should exclude _private folders', () => {
      const tree = scanRoutes(TEST_DIR);
      const secretRoute = tree.routes.find(r => r.urlPath === '/secret' || r.urlPath === '/_private/secret');
      expect(secretRoute).toBeUndefined();
    });
  });

  describe('Special exports', () => {
    it('should detect errorComponent export', () => {
      const tree = scanRoutes(TEST_DIR);
      const errorRoute = tree.routes.find(r => r.urlPath === '/error-test');
      expect(errorRoute?.hasErrorComponent).toBe(true);
    });

    it('should detect generateStaticParams export', () => {
      const tree = scanRoutes(TEST_DIR);
      const ssgRoute = tree.routes.find(r => r.urlPath === '/ssg-test');
      expect(ssgRoute?.hasGenerateStaticParams).toBe(true);
    });
  });

  describe('Layouts', () => {
    it('should detect root layout', () => {
      const tree = scanRoutes(TEST_DIR);
      expect(tree.root).toBeDefined();
      expect(tree.root?.type).toBe('root');
    });

    it('should detect scoped layouts', () => {
      const tree = scanRoutes(TEST_DIR);
      const postsLayout = tree.layouts.find(l => l.scopePath === 'posts');
      expect(postsLayout).toBeDefined();
    });
  });

  describe('Legacy $param support', () => {
    // Create a legacy test
    beforeAll(() => {
      writeFileSync(join(TEST_DIR, '$legacy.tsx'), 'export default function Legacy() {}');
    });

    it('should still support $param syntax', () => {
      const tree = scanRoutes(TEST_DIR);
      const legacyRoute = tree.routes.find(r => r.urlPath === '/:legacy');
      expect(legacyRoute).toBeDefined();
      expect(legacyRoute?.params[0].name).toBe('legacy');
    });
  });
});

describe('SSG utilities', () => {
  it('should build path from pattern and params', async () => {
    const { buildPath } = await import('./ssg.js');

    expect(buildPath('/posts/:id', { id: '123' })).toBe('/posts/123');
    expect(buildPath('/blog/*slug', { slug: 'a/b/c' })).toBe('/blog/a/b/c');
    expect(buildPath('/docs/*path?', { path: '' })).toBe('/docs');
    expect(buildPath('/docs/*path?', {})).toBe('/docs');
    expect(buildPath('/', {})).toBe('/');
  });

  it('should generate output paths', async () => {
    const { getOutputPath } = await import('./ssg.js');

    expect(getOutputPath('/', 'dist')).toBe('dist/index.html');
    expect(getOutputPath('/posts/123', 'dist')).toBe('dist/posts/123/index.html');
    expect(getOutputPath('/blog/a/b', 'dist')).toBe('dist/blog/a/b/index.html');
  });
});
