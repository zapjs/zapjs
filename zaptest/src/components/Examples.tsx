import { motion, useInView, AnimatePresence } from 'framer-motion';
import { useRef, useState, useEffect } from 'react';
import {
  Code2,
  Zap,
  Activity,
  Users,
  FileText,
  Mail,
  Radio,
  Copy,
  Check,
  ChevronRight,
  Play,
  ExternalLink,
  Wifi,
  Layers,
  BookOpen,
} from 'lucide-react';
import { highlightCode, tokensToHtml } from '../lib/utils';

interface ApiExample {
  id: string;
  name: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  description: string;
  category: 'simple' | 'complex' | 'advanced';
  icon: typeof Zap;
  sampleResponse?: unknown;
  sampleBody?: unknown;
  curl: string;
  codeSnippet: string;
}

const examples: ApiExample[] = [
  {
    id: 'stats',
    name: 'Site Stats',
    endpoint: '/api/stats',
    method: 'GET',
    description: 'Returns live site statistics including uptime and request counts.',
    category: 'simple',
    icon: Activity,
    curl: 'curl http://localhost:3000/api/stats',
    codeSnippet: `import { rpc } from '@zap-js/server';
import type { StatsResponse, ApiError } from './generated/types';

// Type-safe RPC call with union return type
const result = await rpc.call<StatsResponse | ApiError>('get_stats', {});

if ('error' in result) {
  // TypeScript knows: ApiError
  console.error(result.code, result.error);
} else {
  // TypeScript knows: StatsResponse
  console.log(result.version);   // string
  console.log(result.uptime);    // string
  console.log(result.requests);  // number
}`,
  },
  {
    id: 'features',
    name: 'Features List',
    endpoint: '/api/features',
    method: 'GET',
    description: 'Returns all ZapJS features displayed on the homepage.',
    category: 'simple',
    icon: Zap,
    curl: 'curl http://localhost:3000/api/features',
    codeSnippet: `import { rpc } from '@zap-js/server';
import type { FeaturesResponse, ApiError } from './generated/types';

const result = await rpc.call<FeaturesResponse | ApiError>('get_features', {});

if ('error' in result) {
  handleError(result); // ApiError
} else {
  // FeaturesResponse - fully typed
  result.features.forEach(f => {
    console.log(f.title);       // string
    console.log(f.icon);        // string
    console.log(f.description); // string
  });
  console.log(result.count);    // number
}`,
  },
  {
    id: 'benchmarks',
    name: 'Benchmarks',
    endpoint: '/api/benchmarks',
    method: 'GET',
    description: 'Performance benchmark data comparing ZapJS to other frameworks.',
    category: 'simple',
    icon: Activity,
    curl: 'curl http://localhost:3000/api/benchmarks',
    codeSnippet: `import { rpc } from '@zap-js/server';
import type { BenchmarksResponse, ApiError } from './generated/types';

const result = await rpc.call<BenchmarksResponse | ApiError>('get_benchmarks', {});

if (!('error' in result)) {
  // BenchmarksResponse with nested types
  result.frameworks.forEach(fw => {
    console.log(fw.name);           // string
    console.log(fw.requestsPerSec); // number
    console.log(fw.latencyMs);      // number
  });
  console.log(result.metrics.p99Latency); // string
  console.log(result.machine);            // string
}`,
  },
  {
    id: 'users',
    name: 'Users CRUD',
    endpoint: '/api/users',
    method: 'GET',
    description: 'Full CRUD operations with validation and error handling.',
    category: 'complex',
    icon: Users,
    curl: 'curl http://localhost:3000/api/users',
    codeSnippet: `import { rpc } from '@zap-js/server';
import type { User, ListUsersResponse, ApiError } from './generated/types';

// List users with pagination
const listResult = await rpc.call<ListUsersResponse | ApiError>('list_users', {
  limit: 10,
  offset: 0
});
if (!('error' in listResult)) {
  listResult.users.forEach(u => console.log(u.name, u.email));
  console.log(\`Total: \${listResult.total}, hasMore: \${listResult.hasMore}\`);
}

// Create a new user
const createResult = await rpc.call<User | ApiError>('create_user', {
  name: 'Alice',
  email: 'alice@example.com',
  role: 'admin'
});
if (!('error' in createResult)) {
  console.log(\`Created user: \${createResult.id}\`);
}`,
  },
  {
    id: 'posts',
    name: 'Blog Posts',
    endpoint: '/api/posts',
    method: 'GET',
    description: 'Paginated blog posts with filtering by tag and author.',
    category: 'complex',
    icon: FileText,
    curl: 'curl "http://localhost:3000/api/posts?page=1&limit=5"',
    codeSnippet: `import { rpc } from '@zap-js/server';
import type { ListPostsResponse, ApiError } from './generated/types';

// Paginated posts with optional filters
const result = await rpc.call<ListPostsResponse | ApiError>('list_posts', {
  page: 1,
  limit: 5,
  tag: 'rust',      // string | null
  author: null      // string | null
});

if (!('error' in result)) {
  // ListPostsResponse with nested Pagination type
  result.posts.forEach(post => {
    console.log(post.title, post.slug, post.tags);
  });
  console.log(\`Page \${result.pagination.page} of \${result.pagination.pages}\`);
  console.log(\`hasNext: \${result.pagination.hasNext}\`);
}`,
  },
  {
    id: 'subscribe',
    name: 'Newsletter',
    endpoint: '/api/subscribe',
    method: 'POST',
    description: 'Email subscription with validation and error responses.',
    category: 'complex',
    icon: Mail,
    sampleBody: { email: 'user@example.com' },
    curl: 'curl -X POST http://localhost:3000/api/subscribe -H "Content-Type: application/json" -d \'{"email":"user@example.com"}\'',
    codeSnippet: `import { rpc } from '@zap-js/server';
import type { SubscribeResponse, ApiError } from './generated/types';

const result = await rpc.call<SubscribeResponse | ApiError>('subscribe', {
  email: 'user@example.com'
});

if ('error' in result) {
  // Typed error handling
  switch (result.code) {
    case 'INVALID_EMAIL':
      showError('Please enter a valid email');
      break;
    case 'ALREADY_SUBSCRIBED':
      showInfo('You are already subscribed!');
      break;
    default:
      showError(result.error);
  }
} else {
  // SubscribeResponse
  showSuccess(\`Subscribed \${result.email} at \${result.subscribedAt}\`);
}`,
  },
  {
    id: 'echo',
    name: 'Request Echo',
    endpoint: '/api/echo',
    method: 'GET',
    description: 'Echoes back request details - great for debugging.',
    category: 'complex',
    icon: Radio,
    curl: 'curl "http://localhost:3000/api/echo?foo=bar"',
    codeSnippet: `import { rpc } from '@zap-js/server';
import type { EchoResponse, ApiError } from './generated/types';

const result = await rpc.call<EchoResponse | ApiError>('echo_request', {
  method: 'GET',
  url: '/api/echo',
  query: { foo: 'bar', debug: 'true' },
  headers: { 'X-Custom': 'value' },
  body: null
});

if (!('error' in result)) {
  // EchoResponse - all fields typed
  console.log(result.method);     // string
  console.log(result.query);      // Record<string, string>
  console.log(result.headers);    // Record<string, string>
  console.log(result.timestamp);  // string
}`,
  },
  // Advanced Features
  {
    id: 'streaming',
    name: 'Streaming Response',
    endpoint: '/api/streaming-info',
    method: 'GET',
    description: 'Server-Sent Events with async generators. Stream data in real-time.',
    category: 'advanced',
    icon: Radio,
    curl: 'curl http://localhost:3000/api/streaming-info',
    codeSnippet: `// routes/api/stream.ts - Streaming endpoint
export const GET = async function* () {
  yield { data: 'event: start\\ndata: {"status":"starting"}\\n\\n' };

  for (let i = 1; i <= 5; i++) {
    await new Promise(r => setTimeout(r, 500));
    yield { data: \`event: progress\\ndata: \${JSON.stringify({ step: i })}\\n\\n\` };
  }

  yield { data: 'event: complete\\ndata: {"done":true}\\n\\n' };
};

// Client-side usage:
const eventSource = new EventSource('/api/stream');
eventSource.addEventListener('progress', (e) => {
  console.log('Progress:', JSON.parse(e.data));
});
eventSource.addEventListener('complete', () => eventSource.close());`,
  },
  {
    id: 'websocket',
    name: 'WebSocket Echo',
    endpoint: '/api/websocket-info',
    method: 'GET',
    description: 'Bidirectional real-time communication. Ping/pong, broadcast, stats.',
    category: 'advanced',
    icon: Wifi,
    curl: 'curl http://localhost:3000/api/websocket-info',
    codeSnippet: `// routes/api/ws-echo.ts - WebSocket handler
import type { WsConnection, WsHandler } from '@zap-js/client';

export const WEBSOCKET: WsHandler = {
  onConnect: async (connection) => {
    connection.send(JSON.stringify({
      type: 'connected',
      id: connection.id
    }));
  },

  onMessage: async (connection, message) => {
    // Echo back with timestamp
    connection.send(JSON.stringify({
      type: 'echo',
      message,
      timestamp: Date.now()
    }));
  },

  onClose: async (connection) => {
    console.log('Disconnected:', connection.id);
  }
};

// Client:
const ws = new WebSocket('ws://localhost:3000/api/ws-echo');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.send(JSON.stringify({ type: 'ping' }));`,
  },
  {
    id: 'ssg',
    name: 'Static Site Generation',
    endpoint: '/api/ssg-info',
    method: 'GET',
    description: 'Pre-render routes at build time with generateStaticParams.',
    category: 'advanced',
    icon: Layers,
    curl: 'curl http://localhost:3000/api/ssg-info',
    codeSnippet: `// routes/blog/[slug].tsx - SSG with dynamic params
import { rpc } from '@zap-js/server';

// Called at build time - generates all blog post pages
export async function generateStaticParams() {
  const response = await rpc.call('list_posts', {
    page: 1, limit: 100, tag: null, author: null
  });
  return response.posts.map(post => ({
    slug: post.slug
  }));
}

// Error boundary for 404s
export function errorComponent({ error, reset }) {
  return (
    <div>
      <h1>Post not found</h1>
      <button onClick={reset}>Try Again</button>
    </div>
  );
}

export default function BlogPost({ params }) {
  // Pre-rendered at build time for each slug
  return <Article slug={params.slug} />;
}`,
  },
  {
    id: 'blog',
    name: 'Blog Posts (SSG)',
    endpoint: '/api/posts',
    method: 'GET',
    description: 'Live blog data from Rust backend. Visit /blog to see SSG in action.',
    category: 'advanced',
    icon: BookOpen,
    curl: 'curl "http://localhost:3000/api/posts?page=1&limit=3"',
    codeSnippet: `// This site's blog is pre-rendered using SSG
// Visit: /blog to see it in action

// The blog posts come from Rust:
// #[export]
// pub fn list_posts(...) -> Result<ListPostsResponse, ApiError>

// And are pre-built via generateStaticParams():
// /blog/getting-started-with-zapjs
// /blog/understanding-file-based-routing
// /blog/type-safe-apis-with-zap-export
// /blog/deploying-zapjs-to-production
// /blog/building-real-time-features
// /blog/performance-optimization-tips

// Each page loads instantly - zero runtime server calls!
// The data was fetched at build time and baked into HTML.`,
  },
];

const methodColors: Record<string, { bg: string; text: string }> = {
  GET: { bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
  POST: { bg: 'bg-sky-500/20', text: 'text-sky-400' },
  PUT: { bg: 'bg-amber-500/20', text: 'text-amber-400' },
  DELETE: { bg: 'bg-rose-500/20', text: 'text-rose-400' },
};

function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`p-2 hover:bg-carbon-700 rounded-lg transition-colors ${className}`}
    >
      {copied ? (
        <Check className="w-4 h-4 text-emerald-400" />
      ) : (
        <Copy className="w-4 h-4 text-carbon-400" />
      )}
    </button>
  );
}

function LiveResponse({ endpoint }: { endpoint: string }) {
  const [response, setResponse] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<NodeJS.Timeout | null>(null);

  const COOLDOWN_MS = 2000; // 2 second cooldown between requests

  const fetchData = async () => {
    if (cooldown > 0 || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint);
      const data = await res.json();
      setResponse(data);
    } catch (err) {
      setError('Failed to fetch');
    }
    setLoading(false);

    // Start cooldown
    setCooldown(COOLDOWN_MS);
    const startTime = Date.now();

    const tick = () => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, COOLDOWN_MS - elapsed);
      setCooldown(remaining);

      if (remaining > 0) {
        cooldownRef.current = setTimeout(tick, 100);
      }
    };
    tick();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearTimeout(cooldownRef.current);
    };
  }, []);

  const isDisabled = loading || cooldown > 0;
  const buttonText = loading
    ? 'Loading...'
    : cooldown > 0
      ? `Wait ${Math.ceil(cooldown / 1000)}s`
      : 'Try It';

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-carbon-500 uppercase tracking-wider">
          Live Response
        </span>
        <button
          onClick={fetchData}
          disabled={isDisabled}
          className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-zap-500/20 text-zap-400 rounded-full hover:bg-zap-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play className="w-3 h-3" />
          {buttonText}
        </button>
      </div>
      <div className="bg-carbon-950 rounded-lg p-3 font-mono text-xs overflow-auto max-h-48">
        {error ? (
          <span className="text-rose-400">{error}</span>
        ) : response ? (
          <pre className="text-carbon-300">
            {JSON.stringify(response, null, 2)}
          </pre>
        ) : (
          <span className="text-carbon-600">Click "Try It" to fetch live data</span>
        )}
      </div>
    </div>
  );
}

function ExampleCard({ example, index }: { example: ApiExample; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-50px' });
  const colors = methodColors[example.method];

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      className="group bg-carbon-900/50 border border-carbon-800 rounded-xl overflow-hidden hover:border-carbon-700 transition-colors"
    >
      {/* Header - fixed height for consistent card sizing */}
      <div
        className="p-5 cursor-pointer min-h-[140px] flex flex-col"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-carbon-800 rounded-lg flex items-center justify-center flex-shrink-0">
              <example.icon className="w-5 h-5 text-zap-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">{example.name}</h3>
              <div className="flex items-center gap-2 mt-1">
                <span className={`px-2 py-0.5 text-xs font-mono font-medium rounded ${colors.bg} ${colors.text}`}>
                  {example.method}
                </span>
                <code className="text-xs text-carbon-400 font-mono">{example.endpoint}</code>
              </div>
            </div>
          </div>
          <ChevronRight
            className={`w-5 h-5 text-carbon-500 transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
        <p className="text-sm text-carbon-400 mt-auto">{example.description}</p>
      </div>

      {/* Expanded content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key={`expanded-${example.id}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-carbon-800 overflow-hidden"
          >
            {/* cURL command */}
            <div className="p-4 border-b border-carbon-800/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-carbon-500 uppercase tracking-wider">cURL</span>
                <CopyButton text={example.curl} />
              </div>
              <code className="block bg-carbon-950 rounded-lg p-3 text-xs text-emerald-400 font-mono overflow-x-auto max-h-16">
                {example.curl}
              </code>
            </div>

            {/* Code snippet */}
            <div className="p-4 border-b border-carbon-800/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-carbon-500 uppercase tracking-wider">TypeScript Usage</span>
                <CopyButton text={example.codeSnippet} />
              </div>
              <pre className="bg-carbon-950 rounded-lg p-3 text-xs font-mono overflow-auto h-48">
                <code
                  className="text-carbon-300"
                  dangerouslySetInnerHTML={{
                    __html: tokensToHtml(highlightCode(example.codeSnippet, 'typescript'))
                  }}
                />
              </pre>
            </div>

            {/* Live response */}
            <div className="p-4">
              <LiveResponse endpoint={example.endpoint} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function Examples() {
  const headerRef = useRef<HTMLDivElement>(null);
  const isHeaderInView = useInView(headerRef, { once: true, margin: '-100px' });

  const simpleExamples = examples.filter(e => e.category === 'simple');
  const complexExamples = examples.filter(e => e.category === 'complex');
  const advancedExamples = examples.filter(e => e.category === 'advanced');

  return (
    <section id="examples" className="relative py-24 sm:py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <motion.div
          ref={headerRef}
          initial={{ opacity: 0, y: 30 }}
          animate={isHeaderInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 bg-sky-500/10 border border-sky-500/20 rounded-full">
            <Code2 className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-medium text-sky-400">API Examples</span>
          </div>

          <h2 className="font-display font-black text-4xl sm:text-5xl md:text-6xl text-white mb-6">
            See it in{' '}
            <span className="text-gradient">action</span>
          </h2>

          <p className="text-lg text-carbon-400 max-w-2xl mx-auto">
            Every endpoint below is live. Click "Try It" to fetch real data from this server.
          </p>
        </motion.div>

        {/* Simple Examples */}
        <div className="mb-12">
          <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
            Simple Endpoints
            <span className="text-sm font-normal text-carbon-500">Static responses</span>
          </h3>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
            {simpleExamples.map((example, index) => (
              <ExampleCard key={example.id} example={example} index={index} />
            ))}
          </div>
        </div>

        {/* Complex Examples */}
        <div className="mb-12">
          <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-violet-500 rounded-full"></span>
            Complex Endpoints
            <span className="text-sm font-normal text-carbon-500">Validation, pagination, CRUD</span>
          </h3>
          <div className="grid md:grid-cols-2 gap-4 items-start">
            {complexExamples.map((example, index) => (
              <ExampleCard key={example.id} example={example} index={index} />
            ))}
          </div>
        </div>

        {/* Advanced Examples */}
        <div>
          <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-zap-500 rounded-full"></span>
            Advanced Features
            <span className="text-sm font-normal text-carbon-500">Streaming, WebSocket, SSG</span>
          </h3>
          <div className="grid md:grid-cols-2 gap-4 items-start">
            {advancedExamples.map((example, index) => (
              <ExampleCard key={example.id} example={example} index={index} />
            ))}
          </div>
        </div>

        {/* Bottom CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isHeaderInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-16 text-center"
        >
          <p className="text-carbon-400 mb-4">
            All these endpoints are defined in <code className="text-zap-400 font-mono">routes/api/</code>
          </p>
          <a
            href="https://github.com/saint0x/zapjs"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-carbon-400 hover:text-white transition-colors"
          >
            View source on GitHub
            <ExternalLink className="w-4 h-4" />
          </a>
        </motion.div>
      </div>
    </section>
  );
}
