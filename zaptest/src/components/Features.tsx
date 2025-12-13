import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';
import {
  Zap,
  FileCode2,
  Gauge,
  Workflow,
  Shield,
  Layers,
  RefreshCw,
  Terminal,
} from 'lucide-react';

const features = [
  {
    icon: Zap,
    title: 'Rust Performance',
    description: '20ns route lookups, MessagePack RPC, connection pooling. Production-grade speed.',
    color: 'zap',
  },
  {
    icon: FileCode2,
    title: 'File-Based Routing',
    description: 'Next.js-style [param] routes, SSG with generateStaticParams, client-side router.',
    color: 'sky',
  },
  {
    icon: Workflow,
    title: 'Full Type Safety',
    description: 'Bidirectional Rust-TypeScript types. Result<T, E> becomes T | Error unions.',
    color: 'emerald',
  },
  {
    icon: Gauge,
    title: 'Production Ready',
    description: 'Security headers, rate limiting, CORS, Prometheus metrics, health probes.',
    color: 'violet',
  },
  {
    icon: Shield,
    title: 'Built-in Resilience',
    description: 'Circuit breaker, IPC retry with backoff, graceful degradation.',
    color: 'rose',
  },
  {
    icon: Layers,
    title: 'Real-time Support',
    description: 'WebSocket handlers, streaming responses, bidirectional communication.',
    color: 'amber',
  },
  {
    icon: RefreshCw,
    title: 'Developer Experience',
    description: 'Hot reload for Rust and TypeScript. ETag caching, structured logging.',
    color: 'cyan',
  },
  {
    icon: Terminal,
    title: 'Simple Deployment',
    description: 'Single ~4MB binary. Docker ready. Cross-compilation supported.',
    color: 'pink',
  },
];

const colorVariants: Record<string, { bg: string; text: string; border: string; glow: string }> = {
  zap: {
    bg: 'bg-zap-500/10',
    text: 'text-zap-400',
    border: 'border-zap-500/20',
    glow: 'group-hover:shadow-zap-500/20',
  },
  sky: {
    bg: 'bg-sky-500/10',
    text: 'text-sky-400',
    border: 'border-sky-500/20',
    glow: 'group-hover:shadow-sky-500/20',
  },
  emerald: {
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    border: 'border-emerald-500/20',
    glow: 'group-hover:shadow-emerald-500/20',
  },
  violet: {
    bg: 'bg-violet-500/10',
    text: 'text-violet-400',
    border: 'border-violet-500/20',
    glow: 'group-hover:shadow-violet-500/20',
  },
  rose: {
    bg: 'bg-rose-500/10',
    text: 'text-rose-400',
    border: 'border-rose-500/20',
    glow: 'group-hover:shadow-rose-500/20',
  },
  amber: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    border: 'border-amber-500/20',
    glow: 'group-hover:shadow-amber-500/20',
  },
  cyan: {
    bg: 'bg-cyan-500/10',
    text: 'text-cyan-400',
    border: 'border-cyan-500/20',
    glow: 'group-hover:shadow-cyan-500/20',
  },
  pink: {
    bg: 'bg-pink-500/10',
    text: 'text-pink-400',
    border: 'border-pink-500/20',
    glow: 'group-hover:shadow-pink-500/20',
  },
};

function FeatureCard({ feature, index }: { feature: typeof features[0]; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-100px' });
  const colors = colorVariants[feature.color];

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      className={`group relative p-6 sm:p-8 bg-carbon-900/30 backdrop-blur-sm border border-carbon-800/50 rounded-2xl hover:border-carbon-700/50 transition-all duration-500 ${colors.glow} hover:shadow-xl`}
    >
      {/* Icon */}
      <div className={`w-12 h-12 ${colors.bg} ${colors.border} border rounded-xl flex items-center justify-center mb-5`}>
        <feature.icon className={`w-6 h-6 ${colors.text}`} />
      </div>

      {/* Content */}
      <h3 className="font-display font-bold text-xl text-white mb-3 group-hover:text-gradient transition-all">
        {feature.title}
      </h3>
      <p className="text-carbon-400 leading-relaxed">
        {feature.description}
      </p>

      {/* Hover gradient */}
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white/[0.02] to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    </motion.div>
  );
}

export default function Features() {
  const headerRef = useRef<HTMLDivElement>(null);
  const isHeaderInView = useInView(headerRef, { once: true, margin: '-100px' });

  return (
    <section id="features" className="relative py-24 sm:py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <motion.div
          ref={headerRef}
          initial={{ opacity: 0, y: 30 }}
          animate={isHeaderInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="text-center mb-16 sm:mb-20"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 bg-zap-500/10 border border-zap-500/20 rounded-full">
            <Zap className="w-4 h-4 text-zap-400" />
            <span className="text-sm font-medium text-zap-400">Features</span>
          </div>
          <h2 className="font-display font-black text-4xl sm:text-5xl md:text-6xl text-white mb-6">
            Ship faster,{' '}
            <span className="text-gradient">run faster</span>
          </h2>
          <p className="text-lg sm:text-xl text-carbon-400 max-w-3xl mx-auto">
            Rust performance. TypeScript DX. One command to start.
          </p>
        </motion.div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
