import { motion } from 'framer-motion';
import {
  Book,
  Code2,
  Layers,
  Zap,
  Workflow,
  Terminal,
  Cpu,
  FileCode2,
  Rocket,
  Check,
  Copy,
  ArrowRight,
} from 'lucide-react';
import { useState } from 'react';
import { cn, highlightCode, tokensToHtml } from '../../lib/utils';
import type { DocSection } from './DocsLayout';

// Code Block Component
function CodeBlock({ code, lang, filename }: { code: string; lang: 'rust' | 'typescript'; filename?: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = highlightCode(code, lang);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-6 rounded-xl overflow-hidden bg-carbon-900/50 border border-carbon-800/50">
      {filename && (
        <div className="flex items-center justify-between px-4 py-2 bg-carbon-900/80 border-b border-carbon-800/50">
          <span className="text-xs font-mono text-carbon-400">{filename}</span>
          <span className="text-xs text-carbon-500 uppercase">{lang}</span>
        </div>
      )}
      <div className="relative">
        <pre className="p-4 overflow-x-auto text-sm leading-relaxed">
          <code dangerouslySetInnerHTML={{ __html: tokensToHtml(highlighted) }} />
        </pre>
        <button
          onClick={handleCopy}
          className={cn(
            'absolute top-3 right-3 p-2 rounded-lg transition-all',
            'opacity-0 group-hover:opacity-100',
            copied
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-carbon-800/50 text-carbon-400 hover:text-white'
          )}
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

// Heading Component
function Heading({ level, children }: { level: 1 | 2 | 3; children: React.ReactNode }) {
  const classes = {
    1: 'font-display font-black text-4xl sm:text-5xl text-white mb-6',
    2: 'font-display font-bold text-2xl sm:text-3xl text-white mt-12 mb-4',
    3: 'font-display font-semibold text-xl text-white mt-8 mb-3',
  };

  const Tag = `h${level}` as const;
  return <Tag className={classes[level]}>{children}</Tag>;
}

// Paragraph Component
function Para({ children }: { children: React.ReactNode }) {
  return <p className="text-carbon-300 leading-relaxed mb-4">{children}</p>;
}

// List Component
function List({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2 mb-6">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-3">
          <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-zap-400 flex-shrink-0" />
          <span className="text-carbon-300">{item}</span>
        </li>
      ))}
    </ul>
  );
}

// Callout Component
function Callout({ type, children }: { type: 'info' | 'warning' | 'tip'; children: React.ReactNode }) {
  const styles = {
    info: 'bg-sky-500/10 border-sky-500/30 text-sky-300',
    warning: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
    tip: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
  };

  return (
    <div className={cn('p-4 rounded-xl border mb-6', styles[type])}>
      {children}
    </div>
  );
}

// Feature Card
function FeatureCard({ icon: Icon, title, description }: { icon: React.ElementType; title: string; description: string }) {
  return (
    <div className="p-5 bg-carbon-900/30 border border-carbon-800/50 rounded-xl">
      <div className="w-10 h-10 bg-zap-500/10 border border-zap-500/20 rounded-lg flex items-center justify-center mb-4">
        <Icon className="w-5 h-5 text-zap-400" />
      </div>
      <h4 className="font-semibold text-white mb-2">{title}</h4>
      <p className="text-sm text-carbon-400">{description}</p>
    </div>
  );
}

// Introduction Section
function IntroductionSection() {
  return (
    <div>
      <Heading level={1}>
        Welcome to <span className="text-gradient">Zap.js</span>
      </Heading>
      <Para>
        Zap.js is a fullstack web framework that combines the performance of Rust with the developer experience of React and TypeScript. Build blazing-fast applications with type-safe server functions and file-based routing.
      </Para>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-8">
        <FeatureCard
          icon={Zap}
          title="Rust Performance"
          description="20ns route lookups, sub-millisecond responses with Hyper-based HTTP server"
        />
        <FeatureCard
          icon={FileCode2}
          title="File-Based Routing"
          description="Create files in routes/, get URL paths with TanStack-style conventions"
        />
        <FeatureCard
          icon={Workflow}
          title="Auto Type Generation"
          description="TypeScript types extracted from Rust functions automatically"
        />
        <FeatureCard
          icon={Terminal}
          title="Simple CLI"
          description="zap new, zap dev, zap build - no config needed to start"
        />
      </div>

      <Heading level={2}>Why Zap.js?</Heading>
      <Para>
        Traditional fullstack frameworks make you choose between performance and developer experience. Zap.js gives you both:
      </Para>
      <List items={[
        'Rust backend compiled to a single ~4MB binary',
        'Hot reload for both Rust and TypeScript',
        'Type-safe RPC from frontend to backend',
        'File-based routing with dynamic parameters',
        'Deploy anywhere with one binary',
      ]} />

      <Callout type="tip">
        <strong>Ready to start?</strong> Jump to the Quick Start section to create your first Zap.js application in under 5 minutes.
      </Callout>
    </div>
  );
}

// Quick Start Section
function QuickStartSection() {
  return (
    <div>
      <Heading level={1}>Quick Start</Heading>
      <Para>
        Get up and running with Zap.js in minutes. This guide will walk you through creating your first application.
      </Para>

      <Heading level={2}>Prerequisites</Heading>
      <List items={[
        'Node.js 18+ or Bun 1.0+',
        'Rust 1.70+ (install via rustup.rs)',
        'macOS, Linux, or Windows (WSL2)',
      ]} />

      <Heading level={2}>Create a New Project</Heading>
      <Para>
        Use the create-zap-app CLI to scaffold a new project:
      </Para>
      <CodeBlock
        lang="typescript"
        code={`npx create-zap-app my-app
cd my-app
npm run dev`}
        filename="Terminal"
      />

      <Para>
        This will create a new Zap.js project with the following structure:
      </Para>
      <CodeBlock
        lang="typescript"
        code={`my-app/
├── routes/
│   ├── __root.tsx       # Root layout
│   ├── index.tsx        # Home page (/)
│   └── api/
│       └── hello.ts     # API route (/api/hello)
├── src/
│   ├── main.tsx         # React entry
│   └── App.tsx          # Root component
├── package.json
├── zap.config.ts
└── Cargo.toml`}
        filename="Project Structure"
      />

      <Heading level={2}>Development Server</Heading>
      <Para>
        The dev server starts automatically when you run <code className="text-zap-400">npm run dev</code>. It provides:
      </Para>
      <List items={[
        'Hot reload for React components',
        'Automatic Rust recompilation',
        'TypeScript binding regeneration',
        'Route scanning and updates',
      ]} />

      <Callout type="info">
        <strong>Development URLs:</strong><br />
        API Server: http://localhost:3000<br />
        Frontend: http://localhost:5173
      </Callout>

      <Heading level={2}>Your First API Route</Heading>
      <Para>
        Create an API route by adding a file in the <code className="text-zap-400">routes/api/</code> directory:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="routes/api/users.ts"
        code={`export const GET = async (req) => {
  return {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };
};

export const POST = async (req) => {
  const body = JSON.parse(req.body);
  return {
    status: 201,
    body: { created: body },
  };
};`}
      />

      <Para>
        Test your API:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Terminal"
        code={`curl http://localhost:3000/api/users
# {"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}`}
      />
    </div>
  );
}

// Project Structure Section
function ProjectStructureSection() {
  return (
    <div>
      <Heading level={1}>Project Structure</Heading>
      <Para>
        Understanding the Zap.js project structure helps you organize your code effectively.
      </Para>

      <Heading level={2}>Directory Overview</Heading>
      <CodeBlock
        lang="typescript"
        filename="Project Layout"
        code={`my-app/
├── routes/              # File-based routing
│   ├── __root.tsx       # Root layout
│   ├── index.tsx        # / (home page)
│   ├── about.tsx        # /about
│   ├── users/
│   │   ├── index.tsx    # /users
│   │   └── [id].tsx     # /users/:id (dynamic)
│   └── api/             # API routes
│       ├── hello.ts     # /api/hello
│       └── users.[id].ts # /api/users/:id
│
├── src/                 # React application
│   ├── main.tsx         # Entry point
│   ├── App.tsx          # Root component
│   ├── components/      # Reusable components
│   └── generated/       # Auto-generated files
│       ├── routeTree.ts
│       └── server.ts
│
├── server/              # Rust backend
│   └── src/
│       └── main.rs
│
├── public/              # Static assets
├── package.json
├── zap.config.ts        # Zap configuration
├── vite.config.ts       # Vite configuration
├── tsconfig.json
└── Cargo.toml           # Rust dependencies`}
      />

      <Heading level={2}>Key Directories</Heading>

      <Heading level={3}>routes/</Heading>
      <Para>
        Contains all your page and API routes. File names map to URL paths:
      </Para>
      <List items={[
        'index.tsx → / (index routes)',
        'about.tsx → /about (named routes)',
        '[id].tsx → /:id (dynamic params)',
        'api/*.ts → /api/* (API routes)',
      ]} />

      <Heading level={3}>src/generated/</Heading>
      <Para>
        Auto-generated files that should not be edited manually:
      </Para>
      <List items={[
        'routeTree.ts - Route manifest for client-side routing',
        'server.ts - Type-safe RPC client for calling Rust functions',
        'backend.d.ts - TypeScript definitions for Rust types',
      ]} />

      <Callout type="warning">
        <strong>Don't edit generated files!</strong> They are regenerated on every build and your changes will be lost.
      </Callout>
    </div>
  );
}

// Architecture Section
function ArchitectureSection() {
  return (
    <div>
      <Heading level={1}>Architecture</Heading>
      <Para>
        Zap.js combines a Rust HTTP server with TypeScript handlers via IPC (Inter-Process Communication).
      </Para>

      <Heading level={2}>System Overview</Heading>
      <CodeBlock
        lang="typescript"
        filename="Architecture Diagram"
        code={`┌─────────────────────────────────────────────────────────────┐
│                     Zap.js Framework                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────┐      ┌────────────────────────────┐  │
│  │  TypeScript Layer │◄────►│       Rust Layer           │  │
│  ├───────────────────┤  IPC ├────────────────────────────┤  │
│  │                   │      │                            │  │
│  │  @zap-js/client   │      │  zap-server (HTTP Server)  │  │
│  │  - Zap class      │      │  - Radix router (20ns)     │  │
│  │  - IPC client     │      │  - Middleware chain        │  │
│  │                   │      │  - Static file serving     │  │
│  │  @zap-js/client    │      │                            │  │
│  │  - File routing   │      │  zap-core (Primitives)     │  │
│  │  - Route scanning │      │  - Zero-copy HTTP parsing  │  │
│  │                   │      │  - Request/Response types  │  │
│  └───────────────────┘      └────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘`}
      />

      <Heading level={2}>Request Flow</Heading>
      <Para>
        When a request hits the server:
      </Para>
      <List items={[
        '1. Rust HTTP server receives the request',
        '2. Radix router matches the path (~20ns for static routes)',
        '3. If TypeScript handler, IPC message sent to Node process',
        '4. TypeScript executes the handler function',
        '5. Response sent back via IPC',
        '6. Rust sends HTTP response to client',
      ]} />

      <Heading level={2}>IPC Protocol</Heading>
      <Para>
        Communication uses Unix Domain Sockets with MessagePack serialization (40% faster than JSON):
      </Para>
      <CodeBlock
        lang="typescript"
        filename="IPC Frame Format"
        code={`// Wire format: [4-byte big-endian length][payload]
// Auto-detect: First byte 0x7B = JSON, else MessagePack

// Request: Rust → TypeScript
{
  "type": "invoke_handler",
  "handler_id": "api_users_get",
  "request": {
    "request_id": "req_123456789_0",
    "method": "GET",
    "path": "/api/users/123",
    "path_only": "/api/users/123",
    "params": { "id": "123" },
    "query": {},
    "headers": { "Accept": "application/json" },
    "body": "",
    "cookies": {}
  }
}

// Response: TypeScript → Rust
{
  "type": "handler_response",
  "handler_id": "api_users_get",
  "status": 200,
  "headers": { "Content-Type": "application/json" },
  "body": "{\\"id\\":123,\\"name\\":\\"John\\"}"
}`}
      />

      <Callout type="info">
        <strong>Performance Note:</strong> IPC adds ~1.2μs overhead per request. Streaming and WebSocket are also supported via StreamChunk and WsMessage IPC types.
      </Callout>
    </div>
  );
}

// Routing Section
function RoutingSection() {
  return (
    <div>
      <Heading level={1}>File-Based Routing</Heading>
      <Para>
        Zap.js uses TanStack Router-style file conventions for automatic route discovery.
      </Para>

      <Heading level={2}>Route Patterns</Heading>
      <div className="overflow-x-auto my-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-carbon-800">
              <th className="text-left py-3 px-4 text-carbon-400 font-medium">File Pattern</th>
              <th className="text-left py-3 px-4 text-carbon-400 font-medium">URL Path</th>
              <th className="text-left py-3 px-4 text-carbon-400 font-medium">Description</th>
            </tr>
          </thead>
          <tbody className="text-carbon-300">
            <tr className="border-b border-carbon-800/50">
              <td className="py-3 px-4 font-mono text-zap-400">index.tsx</td>
              <td className="py-3 px-4">/</td>
              <td className="py-3 px-4">Index route</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-3 px-4 font-mono text-zap-400">about.tsx</td>
              <td className="py-3 px-4">/about</td>
              <td className="py-3 px-4">Static route</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-3 px-4 font-mono text-zap-400">[id].tsx</td>
              <td className="py-3 px-4">/:id</td>
              <td className="py-3 px-4">Dynamic param</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-3 px-4 font-mono text-zap-400">users.[id].tsx</td>
              <td className="py-3 px-4">/users/:id</td>
              <td className="py-3 px-4">Nested dynamic</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-3 px-4 font-mono text-zap-400">_layout.tsx</td>
              <td className="py-3 px-4">-</td>
              <td className="py-3 px-4">Layout wrapper</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-3 px-4 font-mono text-zap-400">__root.tsx</td>
              <td className="py-3 px-4">-</td>
              <td className="py-3 px-4">Root layout</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-3 px-4 font-mono text-zap-400">(group)/</td>
              <td className="py-3 px-4">-</td>
              <td className="py-3 px-4">Route group (no URL)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Heading level={2}>Dynamic Routes</Heading>
      <Para>
        Use <code className="text-zap-400">[brackets]</code> for dynamic segments:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="routes/users/[id].tsx"
        code={`export default function UserPage({ params }) {
  return <h1>User {params.id}</h1>;
}`}
      />

      <Heading level={2}>Layouts</Heading>
      <Para>
        Create layouts to wrap child routes:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="routes/__root.tsx"
        code={`export default function RootLayout({ children }) {
  return (
    <html>
      <head>
        <title>My App</title>
      </head>
      <body>
        <nav>Navigation</nav>
        {children}
        <footer>Footer</footer>
      </body>
    </html>
  );
}`}
      />
    </div>
  );
}

// API Routes Section
function ApiRoutesSection() {
  return (
    <div>
      <Heading level={1}>API Routes</Heading>
      <Para>
        API routes let you create HTTP endpoints using file-based routing in the <code className="text-zap-400">routes/api/</code> directory.
      </Para>

      <Heading level={2}>HTTP Method Exports</Heading>
      <Para>
        Export named functions for each HTTP method you want to handle:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="routes/api/users.ts"
        code={`// GET /api/users
export const GET = async (req) => {
  return { users: [...] };
};

// POST /api/users
export const POST = async (req) => {
  const body = JSON.parse(req.body);
  return { status: 201, body: { created: body } };
};

// PUT /api/users
export const PUT = async (req) => { ... };

// DELETE /api/users
export const DELETE = async (req) => { ... };`}
      />

      <Heading level={2}>Request Object</Heading>
      <Para>
        Every handler receives a request object with all HTTP details:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Request Structure"
        code={`interface ZapRequest {
  method: string;           // "GET", "POST", etc.
  path: string;             // "/api/users/123?page=1"
  path_only: string;        // "/api/users/123"
  query: Record<string, string>;   // { page: "1" }
  params: Record<string, string>;  // { id: "123" }
  headers: Record<string, string>;
  body: string;
  cookies: Record<string, string>;
}`}
      />

      <Heading level={2}>Response Formats</Heading>
      <Para>
        Return objects for JSON, or customize status and headers:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Response Examples"
        code={`// Simple JSON response (200 OK)
export const GET = async () => {
  return { message: 'Hello!' };
};

// Custom status and headers
export const POST = async () => {
  return {
    status: 201,
    headers: { 'X-Custom': 'value' },
    body: { created: true },
  };
};

// Error response
export const GET = async (req) => {
  const user = await db.find(req.params.id);
  if (!user) {
    return { status: 404, body: { error: 'Not found' } };
  }
  return user;
};`}
      />
    </div>
  );
}

// Server Functions Section
function ServerFunctionsSection() {
  return (
    <div>
      <Heading level={1}>Server Functions</Heading>
      <Para>
        Server functions let you call Rust code from TypeScript with full type safety via RPC.
      </Para>

      <Heading level={2}>Writing Server Functions</Heading>
      <Para>
        Mark Rust functions with <code className="text-zap-400">#[export]</code>:
      </Para>
      <CodeBlock
        lang="rust"
        filename="server/src/main.rs"
        code={`use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[export]
pub async fn get_user(id: String) -> Result<User, ApiError> {
    // Your logic here
    Ok(User {
        id,
        name: "John Doe".to_string(),
        email: "john@example.com".to_string(),
    })
}`}
      />

      <Heading level={2}>Using RPC in TypeScript</Heading>
      <Para>
        Call Rust functions using the <code className="text-zap-400">rpc</code> namespace from the SDK:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Calling Server Functions"
        code={`import { rpc } from '@zap-js/server';
import type { User, ApiError } from './generated/types';

// Type-safe RPC call with Result<T, E> union type
const result = await rpc.call<User | ApiError>('get_user', { id: '123' });

if ('code' in result) {
  // TypeScript knows this is ApiError
  console.error(result.code, result.message);
} else {
  // TypeScript knows this is User
  console.log(result.name, result.email);
}`}
      />

      <Heading level={2}>Using in React</Heading>
      <CodeBlock
        lang="typescript"
        filename="src/components/UserProfile.tsx"
        code={`import { useState, useEffect } from 'react';
import { rpc } from '@zap-js/server';
import type { User, ApiError } from '../generated/types';

function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call<User | ApiError>('get_user', { id: userId }).then(result => {
      // Result<T, E> becomes T | E union type
      if ('code' in result) {
        setError(result.message);  // ApiError
      } else {
        setUser(result);  // User
      }
    });
  }, [userId]);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!user) return <p>Loading...</p>;
  return <h1>{user.name}</h1>;
}`}
      />

      <Heading level={2}>Type Mapping</Heading>
      <div className="overflow-x-auto my-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-carbon-800">
              <th className="text-left py-3 px-4 text-carbon-400 font-medium">Rust</th>
              <th className="text-left py-3 px-4 text-carbon-400 font-medium">TypeScript</th>
            </tr>
          </thead>
          <tbody className="text-carbon-300 font-mono">
            <tr className="border-b border-carbon-800/50">
              <td className="py-2 px-4 text-rust-400">String</td>
              <td className="py-2 px-4 text-sky-400">string</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-2 px-4 text-rust-400">i32, u64, f64</td>
              <td className="py-2 px-4 text-sky-400">number</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-2 px-4 text-rust-400">bool</td>
              <td className="py-2 px-4 text-sky-400">boolean</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-2 px-4 text-rust-400">{"Option<T>"}</td>
              <td className="py-2 px-4 text-sky-400">T | null</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-2 px-4 text-rust-400">{"Vec<T>"}</td>
              <td className="py-2 px-4 text-sky-400">T[]</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-2 px-4 text-rust-400">{"Result<T, E>"}</td>
              <td className="py-2 px-4 text-sky-400">{"T | E (union type)"}</td>
            </tr>
            <tr className="border-b border-carbon-800/50">
              <td className="py-2 px-4 text-rust-400">{"HashMap<K, V>"}</td>
              <td className="py-2 px-4 text-sky-400">{"Record<K, V>"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Performance Section
function PerformanceSection() {
  return (
    <div>
      <Heading level={1}>Performance</Heading>
      <Para>
        Zap.js is designed for high-performance applications with sub-millisecond response times.
      </Para>

      <Heading level={2}>Benchmarks</Heading>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-6">
        <div className="p-5 bg-carbon-900/30 border border-carbon-800/50 rounded-xl">
          <p className="text-xs text-carbon-500 uppercase tracking-wider mb-1">Static Route Lookup</p>
          <p className="text-3xl font-display font-bold text-zap-400">~20ns</p>
        </div>
        <div className="p-5 bg-carbon-900/30 border border-carbon-800/50 rounded-xl">
          <p className="text-xs text-carbon-500 uppercase tracking-wider mb-1">Dynamic Route Lookup</p>
          <p className="text-3xl font-display font-bold text-zap-400">~81ns</p>
        </div>
        <div className="p-5 bg-carbon-900/30 border border-carbon-800/50 rounded-xl">
          <p className="text-xs text-carbon-500 uppercase tracking-wider mb-1">IPC Round-Trip</p>
          <p className="text-3xl font-display font-bold text-zap-400">~1.2μs</p>
        </div>
        <div className="p-5 bg-carbon-900/30 border border-carbon-800/50 rounded-xl">
          <p className="text-xs text-carbon-500 uppercase tracking-wider mb-1">Binary Size</p>
          <p className="text-3xl font-display font-bold text-zap-400">~4MB</p>
        </div>
      </div>

      <Heading level={2}>Optimizations</Heading>
      <List items={[
        'Zero-copy HTTP parsing - No allocations for request data',
        'Radix tree router - O(log n) for dynamic paths',
        'SIMD string operations - Fast byte scanning',
        'Link-time optimization - Smaller, faster binaries',
        'Connection keep-alive - Reuse TCP connections',
      ]} />

      <Heading level={2}>Release Build</Heading>
      <Para>
        Production builds use aggressive optimizations:
      </Para>
      <CodeBlock
        lang="rust"
        filename="Cargo.toml"
        code={`[profile.release]
lto = "fat"           # Link-time optimization
codegen-units = 1     # Single codegen unit
panic = "abort"       # Smaller binary
opt-level = 3         # Maximum optimization`}
      />
    </div>
  );
}

// Deployment Section
function DeploymentSection() {
  return (
    <div>
      <Heading level={1}>Deployment</Heading>
      <Para>
        Deploy your Zap.js application as a single binary anywhere that runs Rust.
      </Para>

      <Heading level={2}>Production Build</Heading>
      <CodeBlock
        lang="typescript"
        filename="Terminal"
        code={`npm run build
# or
zap build`}
      />

      <Para>
        This creates a <code className="text-zap-400">dist/</code> directory:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Output Structure"
        code={`dist/
├── bin/zap          # Rust binary (~4MB)
├── static/          # Frontend assets
├── config.json      # Server configuration
└── manifest.json    # Build metadata`}
      />

      <Heading level={2}>Running in Production</Heading>
      <CodeBlock
        lang="typescript"
        filename="Terminal"
        code={`cd dist
./bin/zap --port 8080 --host 0.0.0.0`}
      />

      <Heading level={2}>Docker Deployment</Heading>
      <CodeBlock
        lang="typescript"
        filename="Dockerfile"
        code={`FROM rust:1.75-slim as builder
WORKDIR /app
COPY . .
RUN npm install && npm run build

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["./dist/bin/zap", "--port", "3000"]`}
      />

      <Callout type="tip">
        <strong>Cross-compilation:</strong> Build for Linux from macOS:<br />
        <code className="text-emerald-300">zap build --target x86_64-unknown-linux-gnu</code>
      </Callout>
    </div>
  );
}

// Client Router Section
function ClientRouterSection() {
  return (
    <div>
      <Heading level={1}>Client Router</Heading>
      <Para>
        ZapJS includes a full client-side router with hooks for navigation, parameters, and search queries.
      </Para>

      <Heading level={2}>Available Exports</Heading>
      <Para>
        Import router utilities from <code className="text-zap-400">@zap-js/client</code>:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Router Imports"
        code={`import {
  // Provider and outlet
  RouterProvider,
  Outlet,

  // Navigation components
  Link,
  NavLink,
  Redirect,

  // Hooks
  useRouter,
  usePathname,
  useParams,
  useSearchParams,

  // Error handling
  ErrorBoundary,
  useRouteError,
  DefaultErrorComponent,
} from '@zap-js/client';`}
      />

      <Heading level={2}>Navigation Hooks</Heading>
      <CodeBlock
        lang="typescript"
        filename="Using Router Hooks"
        code={`import { router } from '@zap-js/client';

function MyComponent() {
  const routerInstance = router.useRouter();
  const { id } = router.useParams<{ id: string }>();
  const pathname = router.usePathname();
  const [searchParams, setSearchParams] = router.useSearchParams();

  // Programmatic navigation
  routerInstance.push('/posts/123');
  routerInstance.replace('/login');
  routerInstance.back();
  routerInstance.prefetch('/dashboard');
}`}
      />

      <Heading level={2}>Link Components</Heading>
      <Para>
        Use Link and NavLink for SPA navigation without full page reloads:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Navigation Components"
        code={`import { router } from '@zap-js/client';

// Basic link
<router.Link to="/posts/123">View Post</router.Link>

// Replace history instead of push
<router.Link to="/posts/123" replace>View Post</router.Link>

// NavLink with active state
<router.NavLink to="/dashboard" activeClassName="active">
  Dashboard
</router.NavLink>`}
      />

      <Callout type="tip">
        <strong>Prefetching:</strong> Links automatically prefetch on hover for instant navigation.
      </Callout>
    </div>
  );
}

// SSG Section
function SSGSection() {
  return (
    <div>
      <Heading level={1}>Static Site Generation</Heading>
      <Para>
        Pre-render dynamic routes at build time using <code className="text-zap-400">generateStaticParams</code>.
      </Para>

      <Heading level={2}>generateStaticParams</Heading>
      <Para>
        Export this function from dynamic route files to define which paths to pre-render:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="routes/blog/[slug].tsx"
        code={`import { rpc } from '@zap-js/server';

interface ListPostsResponse {
  posts: Array<{ slug: string }>;
}

// Called at build time to generate static pages
export async function generateStaticParams(): Promise<Array<{ slug: string }>> {
  const response = await rpc.call<ListPostsResponse>('list_posts', {
    page: 1,
    limit: 100,
    tag: null,
    author: null
  });
  return response.posts.map(post => ({ slug: post.slug }));
}

// Also export an error component for better UX
export function errorComponent({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <h1>Post not found</h1>
      <p>{error.message}</p>
      <button onClick={reset}>Try Again</button>
    </div>
  );
}

export default function BlogPost({ params }: { params: { slug: string } }) {
  // Component renders for each pre-generated slug
  return <Article slug={params.slug} />;
}`}
      />

      <Heading level={2}>Build Output</Heading>
      <Para>
        SSG generates static HTML files for each parameter combination:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Build Output"
        code={`dist/
├── blog/
│   ├── hello-world/index.html    # /blog/hello-world
│   ├── intro-to-rust/index.html  # /blog/intro-to-rust
│   └── zapjs-guide/index.html    # /blog/zapjs-guide
└── ssg-manifest.json             # Tracks pre-rendered paths`}
      />

      <Callout type="info">
        <strong>Hybrid Rendering:</strong> Routes without generateStaticParams render on request. Mix SSG and dynamic routes freely.
      </Callout>
    </div>
  );
}

// Enhanced RPC Section
function EnhancedRPCSection() {
  return (
    <div>
      <Heading level={1}>Enhanced RPC</Heading>
      <Para>
        ZapJS uses an optimized RPC protocol with MessagePack serialization, connection pooling, and streaming support.
      </Para>

      <Heading level={2}>MessagePack Serialization</Heading>
      <Para>
        Default protocol is MessagePack, ~40% faster than JSON:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Frame Format"
        code={`// Wire format: [4-byte big-endian length][payload]
// Auto-detect: First byte 0x7B = JSON, else MessagePack

// No changes needed in your code - transparent optimization`}
      />

      <Heading level={2}>Connection Pooling</Heading>
      <Para>
        Eliminates per-request connection overhead:
      </Para>
      <List items={[
        '4 persistent connections (configurable)',
        'Round-robin distribution',
        'Automatic reconnection on failure',
        'Health checks with keep-alive',
      ]} />

      <Heading level={2}>Streaming Responses</Heading>
      <Para>
        Use async generators for SSE (Server-Sent Events) or chunked data:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="routes/api/stream.ts"
        code={`// Streaming response using async generator
export const GET = async function* () {
  // Initial event
  yield { data: \`event: start\\ndata: \${JSON.stringify({ status: 'starting' })}\\n\\n\` };

  // Stream progress
  for (let i = 1; i <= 5; i++) {
    await new Promise(r => setTimeout(r, 500));
    yield {
      data: \`event: progress\\ndata: \${JSON.stringify({ step: i, total: 5 })}\\n\\n\`
    };
  }

  // Complete
  yield { data: \`event: complete\\ndata: \${JSON.stringify({ done: true })}\\n\\n\` };
};`}
      />

      <Heading level={2}>WebSocket Support</Heading>
      <Para>
        Export a <code className="text-zap-400">WEBSOCKET</code> handler for bidirectional real-time communication:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="routes/api/ws-echo.ts"
        code={`import type { WsConnection, WsHandler } from '@zap-js/client';

const clients = new Map<string, WsConnection>();

export const WEBSOCKET: WsHandler = {
  onConnect: async (connection) => {
    clients.set(connection.id, connection);
    connection.send(JSON.stringify({
      type: 'connected',
      id: connection.id,
      totalClients: clients.size
    }));
  },

  onMessage: async (connection, message) => {
    // message is string or Uint8Array
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    connection.send(JSON.stringify({ type: 'echo', message: text }));
  },

  onClose: async (connection, code, reason) => {
    clients.delete(connection.id);
  },

  onError: async (connection, error) => {
    console.error(\`WS Error: \${error.message}\`);
  }
};`}
      />
    </div>
  );
}

// Security Section
function SecuritySection() {
  return (
    <div>
      <Heading level={1}>Security</Heading>
      <Para>
        Production-ready security features built in.
      </Para>

      <Heading level={2}>Security Headers</Heading>
      <Para>
        Applied automatically to all responses:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Default Headers"
        code={`X-Frame-Options: DENY
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: <configurable>`}
      />

      <Heading level={2}>Rate Limiting</Heading>
      <Para>
        Token bucket algorithm per IP address:
      </Para>
      <List items={[
        'Default: 100 requests/minute',
        'Returns 429 with Retry-After header',
        'Pluggable storage (in-memory default, Redis optional)',
      ]} />

      <Heading level={2}>CORS Configuration</Heading>
      <Para>
        Strict CORS by default - explicit origin allowlist required:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="zap.config.ts"
        code={`export default {
  cors: {
    origins: ['https://app.example.com'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
};`}
      />
    </div>
  );
}

// Observability Section
function ObservabilitySection() {
  return (
    <div>
      <Heading level={1}>Observability</Heading>
      <Para>
        Built-in monitoring, logging, and tracing for production deployments.
      </Para>

      <Heading level={2}>Prometheus Metrics</Heading>
      <Para>
        Metrics endpoint at <code className="text-zap-400">/metrics</code>:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Available Metrics"
        code={`http_requests_total{method="GET", path="/api/users", status="200"} 1234
http_request_duration_seconds{method="GET", path="/api/users"} 0.015
http_requests_in_flight 5
ipc_invoke_duration_seconds{handler_id="handler_0"} 0.008`}
      />

      <Heading level={2}>Request ID Correlation</Heading>
      <Para>
        Every request gets a unique ID for tracing:
      </Para>
      <List items={[
        'Incoming X-Request-ID header preserved',
        'Auto-generated UUID if not present',
        'Passed through IPC to TypeScript handlers',
        'Included in all log entries',
      ]} />

      <Heading level={2}>Structured Logging</Heading>
      <CodeBlock
        lang="typescript"
        filename="Using the Logger"
        code={`import { logger } from '@zap-js/client';

logger.info('User created', { request_id, userId: '123' });
// {"level":"info","message":"User created","request_id":"abc-123","userId":"123","timestamp":"..."}`}
      />
    </div>
  );
}

// Error Handling Section
function ErrorHandlingSection() {
  return (
    <div>
      <Heading level={1}>Error Handling</Heading>
      <Para>
        React error boundaries with route-level customization.
      </Para>

      <Heading level={2}>errorComponent Export</Heading>
      <Para>
        Export an error component from route files for custom error UI:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="routes/users/[id].tsx"
        code={`export default function UserPage({ params }) {
  return <UserProfile userId={params.id} />;
}

export function errorComponent({ error, reset }) {
  return (
    <div>
      <h1>Failed to load user</h1>
      <p>{error.message}</p>
      {error.digest && <small>Error ID: {error.digest}</small>}
      <button onClick={reset}>Try Again</button>
    </div>
  );
}`}
      />

      <Heading level={2}>useRouteError Hook</Heading>
      <CodeBlock
        lang="typescript"
        filename="Using useRouteError"
        code={`import { errors } from '@zap-js/client';

export function errorComponent() {
  const { error, reset } = errors.useRouteError();
  return <MyErrorUI error={error} onRetry={reset} />;
}`}
      />

      <Heading level={2}>Error Interface</Heading>
      <CodeBlock
        lang="typescript"
        filename="ZapRouteError"
        code={`interface ZapRouteError {
  message: string;
  code?: string;      // "HANDLER_ERROR", "VALIDATION_ERROR"
  status?: number;    // HTTP status code
  digest?: string;    // Server error correlation ID
  stack?: string;     // Stack trace (dev only)
  details?: Record<string, unknown>;
}`}
      />

      <Callout type="info">
        <strong>Automatic Fallback:</strong> A DefaultErrorComponent is used when no custom errorComponent is exported.
      </Callout>
    </div>
  );
}

// Caching Section
function CachingSection() {
  return (
    <div>
      <Heading level={1}>Caching</Heading>
      <Para>
        HTTP caching with ETag and Last-Modified support.
      </Para>

      <Heading level={2}>ETag Generation</Heading>
      <Para>
        Automatic cache validation for static files:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="ETag Strategies"
        code={`// Weak ETag (default): W/"size-mtime_hex" - fast, no hashing
// Strong ETag: "sha256_hex" - content-based, precise

staticFiles: {
  etag_strategy: 'weak',  // 'weak' | 'strong' | 'none'
}`}
      />

      <Heading level={2}>Conditional Requests</Heading>
      <Para>
        Returns 304 Not Modified when:
      </Para>
      <List items={[
        'If-None-Match header matches ETag',
        'If-Modified-Since header is after Last-Modified',
      ]} />

      <Heading level={2}>Configuration</Heading>
      <CodeBlock
        lang="typescript"
        filename="zap.config.ts"
        code={`staticFiles: {
  etag_strategy: 'weak',
  enable_last_modified: true,
  cache_control: 'public, max-age=3600',
}`}
      />
    </div>
  );
}

// Reliability Section
function ReliabilitySection() {
  return (
    <div>
      <Heading level={1}>Reliability</Heading>
      <Para>
        Built-in resilience patterns for production stability.
      </Para>

      <Heading level={2}>IPC Retry Logic</Heading>
      <Para>
        Exponential backoff with full jitter:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Retry Configuration"
        code={`// Default configuration:
// - Base delay: 100ms
// - Max delay: 10s
// - Max retries: 3
// - Formula: min(max_delay, base_delay * 2^attempt) * random(0, 1)

// Non-retryable errors (400, 401, 403, 429) fail immediately`}
      />

      <Heading level={2}>Circuit Breaker</Heading>
      <Para>
        Prevents cascading failures with automatic recovery:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Circuit Breaker States"
        code={`// States: CLOSED → OPEN → HALF_OPEN → CLOSED

circuit_breaker: {
  failure_threshold: 5,      // Open after 5 failures
  reset_timeout: '30s',      // Wait before half-open
  success_threshold: 3,      // Close after 3 successes
  failure_window: '60s',     // Failure counting window
}

// When OPEN: Returns 503 Service Unavailable immediately`}
      />

      <Heading level={2}>Health Checks</Heading>
      <Para>
        Kubernetes-compatible liveness and readiness probes:
      </Para>
      <CodeBlock
        lang="typescript"
        filename="Health Endpoints"
        code={`// GET /health/live - Liveness probe
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime_secs": 3600
}

// GET /health/ready - Readiness probe
{
  "status": "healthy",  // or "degraded", "unhealthy"
  "components": [
    { "name": "connection_pool", "status": "healthy" },
    { "name": "circuit_breaker", "status": "healthy" }
  ]
}`}
      />
    </div>
  );
}

// Export all sections
export const docSections: DocSection[] = [
  { id: 'introduction', title: 'Introduction', icon: Book, content: <IntroductionSection /> },
  { id: 'quick-start', title: 'Quick Start', icon: Rocket, content: <QuickStartSection /> },
  { id: 'project-structure', title: 'Project Structure', icon: Layers, content: <ProjectStructureSection /> },
  { id: 'architecture', title: 'Architecture', icon: Cpu, content: <ArchitectureSection /> },
  { id: 'routing', title: 'File-Based Routing', icon: FileCode2, content: <RoutingSection /> },
  { id: 'client-router', title: 'Client Router', icon: FileCode2, content: <ClientRouterSection /> },
  { id: 'ssg', title: 'Static Site Generation', icon: Layers, content: <SSGSection /> },
  { id: 'api-routes', title: 'API Routes', icon: Code2, content: <ApiRoutesSection /> },
  { id: 'enhanced-rpc', title: 'Enhanced RPC', icon: Zap, content: <EnhancedRPCSection /> },
  { id: 'server-functions', title: 'Server Functions', icon: Workflow, content: <ServerFunctionsSection /> },
  { id: 'security', title: 'Security', icon: Zap, content: <SecuritySection /> },
  { id: 'observability', title: 'Observability', icon: Zap, content: <ObservabilitySection /> },
  { id: 'error-handling', title: 'Error Handling', icon: Zap, content: <ErrorHandlingSection /> },
  { id: 'caching', title: 'Caching', icon: Zap, content: <CachingSection /> },
  { id: 'reliability', title: 'Reliability', icon: Zap, content: <ReliabilitySection /> },
  { id: 'performance', title: 'Performance', icon: Zap, content: <PerformanceSection /> },
  { id: 'deployment', title: 'Deployment', icon: Terminal, content: <DeploymentSection /> },
];
