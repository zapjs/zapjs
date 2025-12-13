import { motion, useInView } from 'framer-motion';
import { useRef, useState, useEffect } from 'react';
import { Gauge, TrendingUp, Zap, Server, Radio } from 'lucide-react';

// Default data (shown immediately, replaced by API data when loaded)
const defaultBenchmarks = [
  { framework: 'ZapJS', requestsPerSec: 162000, latency: 0.8, color: 'zap', isZap: true },
  { framework: 'Actix', requestsPerSec: 140000, latency: 0.9, color: 'rust', isZap: false },
  { framework: 'Hyper', requestsPerSec: 135000, latency: 1.0, color: 'violet', isZap: false },
  { framework: 'Express', requestsPerSec: 14400, latency: 8.5, color: 'emerald', isZap: false },
  { framework: 'Next.js', requestsPerSec: 12000, latency: 10.2, color: 'sky', isZap: false },
];

const colorMap: Record<string, string> = {
  ZapJS: 'zap',
  Actix: 'rust',
  Hyper: 'violet',
  Express: 'emerald',
  'Next.js': 'sky',
};

const maxRequests = 170000;

function AnimatedNumber({ value, suffix = '', duration = 2 }: { value: number; suffix?: string; duration?: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });

  useEffect(() => {
    if (!isInView) return;

    const startTime = Date.now();
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / (duration * 1000), 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.floor(value * eased));

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  }, [isInView, value, duration]);

  return (
    <span ref={ref}>
      {displayValue.toLocaleString()}{suffix}
    </span>
  );
}

interface Benchmark {
  framework: string;
  requestsPerSec: number;
  latency: number;
  color: string;
  isZap: boolean;
}

function BenchmarkBar({ benchmark, index }: { benchmark: Benchmark; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-50px' });
  const percentage = (benchmark.requestsPerSec / maxRequests) * 100;

  const colorClasses: Record<string, { bg: string; border: string; text: string }> = {
    zap: { bg: 'bg-gradient-to-r from-zap-500 to-zap-400', border: 'border-zap-500/30', text: 'text-zap-400' },
    rust: { bg: 'bg-gradient-to-r from-rust-500 to-rust-400', border: 'border-rust-500/30', text: 'text-rust-400' },
    violet: { bg: 'bg-gradient-to-r from-violet-500 to-violet-400', border: 'border-violet-500/30', text: 'text-violet-400' },
    emerald: { bg: 'bg-gradient-to-r from-emerald-500 to-emerald-400', border: 'border-emerald-500/30', text: 'text-emerald-400' },
    sky: { bg: 'bg-gradient-to-r from-sky-500 to-sky-400', border: 'border-sky-500/30', text: 'text-sky-400' },
  };

  const colors = colorClasses[benchmark.color];

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, x: -30 }}
      animate={isInView ? { opacity: 1, x: 0 } : {}}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      className={`relative p-4 sm:p-5 rounded-xl border ${colors.border} ${benchmark.isZap ? 'bg-zap-500/5' : 'bg-carbon-900/30'}`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className={`font-semibold ${benchmark.isZap ? 'text-white' : 'text-carbon-300'}`}>
            {benchmark.framework}
          </span>
          {benchmark.isZap && (
            <span className="px-2 py-0.5 text-xs font-medium bg-zap-500/20 text-zap-400 rounded-full">
              This site
            </span>
          )}
        </div>
        <div className="text-right">
          <span className={`font-mono font-bold ${colors.text}`}>
            <AnimatedNumber value={benchmark.requestsPerSec} />
          </span>
          <span className="text-carbon-500 text-sm ml-1">req/s</span>
        </div>
      </div>

      <div className="relative h-3 bg-carbon-800 rounded-full overflow-hidden">
        <motion.div
          className={`absolute inset-y-0 left-0 ${colors.bg} rounded-full`}
          initial={{ width: 0 }}
          animate={isInView ? { width: `${percentage}%` } : {}}
          transition={{ duration: 1, delay: index * 0.1 + 0.3, ease: 'easeOut' }}
        />
        {benchmark.isZap && (
          <motion.div
            className="absolute inset-y-0 left-0 bg-white/20 rounded-full"
            initial={{ width: 0 }}
            animate={isInView ? { width: `${percentage}%` } : {}}
            transition={{ duration: 1.2, delay: index * 0.1 + 0.5, ease: 'easeOut' }}
            style={{ filter: 'blur(4px)' }}
          />
        )}
      </div>

      <div className="mt-2 text-right">
        <span className="text-carbon-500 text-sm">
          Avg latency: <span className={colors.text}>{benchmark.latency}ms</span>
        </span>
      </div>
    </motion.div>
  );
}

export default function Performance() {
  const headerRef = useRef<HTMLDivElement>(null);
  const isHeaderInView = useInView(headerRef, { once: true, margin: '-100px' });
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>(defaultBenchmarks);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    fetch('/api/benchmarks')
      .then(res => res.json())
      .then(data => {
        if (data.frameworks) {
          const mapped = data.frameworks.map((f: { name: string; requestsPerSec: number; latencyMs: number; isHighlighted: boolean }) => ({
            framework: f.name,
            requestsPerSec: f.requestsPerSec,
            latency: f.latencyMs,
            color: colorMap[f.name] || 'carbon',
            isZap: f.isHighlighted,
          }));
          setBenchmarks(mapped);
          setIsLive(true);
        }
      })
      .catch(() => {
        // Keep default data on error
      });
  }, []);

  return (
    <section id="performance" className="relative py-24 sm:py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          {/* Left: Stats & Info */}
          <motion.div
            ref={headerRef}
            initial={{ opacity: 0, y: 30 }}
            animate={isHeaderInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 bg-rust-500/10 border border-rust-500/20 rounded-full">
              <Gauge className="w-4 h-4 text-rust-400" />
              <span className="text-sm font-medium text-rust-400">Performance</span>
            </div>

            <h2 className="font-display font-black text-4xl sm:text-5xl text-white mb-6">
              Actually{' '}
              <span className="text-gradient">fast</span>
            </h2>

            <p className="text-lg text-carbon-400 mb-8 leading-relaxed">
              Built on Hyper and Tokio.
              Your business logic runs at native speed.
            </p>

            {/* Key metrics */}
            <div className="grid grid-cols-2 gap-4 sm:gap-6">
              {[
                { icon: Zap, label: 'Route Lookup', value: '20ns', color: 'zap' },
                { icon: TrendingUp, label: 'Throughput', value: '162k', suffix: '/s', color: 'emerald' },
                { icon: Server, label: 'Memory', value: '12MB', color: 'sky' },
                { icon: Gauge, label: 'P99 Latency', value: '<3ms', color: 'violet' },
              ].map((metric, i) => (
                <motion.div
                  key={metric.label}
                  initial={{ opacity: 0, y: 20 }}
                  animate={isHeaderInView ? { opacity: 1, y: 0 } : {}}
                  transition={{ duration: 0.5, delay: 0.2 + i * 0.1 }}
                  className="p-4 bg-carbon-900/50 border border-carbon-800 rounded-xl"
                >
                  <metric.icon className={`w-5 h-5 text-${metric.color}-400 mb-2`} />
                  <div className="font-display font-bold text-2xl text-white">
                    {metric.value}
                  </div>
                  <div className="text-sm text-carbon-500">{metric.label}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Right: Benchmark bars */}
          <div className="space-y-4">
            {benchmarks.map((benchmark, index) => (
              <BenchmarkBar key={benchmark.framework} benchmark={benchmark} index={index} />
            ))}

            <motion.div
              initial={{ opacity: 0 }}
              animate={isHeaderInView ? { opacity: 1 } : {}}
              transition={{ delay: 1 }}
              className="text-center mt-6"
            >
              <p className="text-sm text-carbon-500">
                Benchmarked on Apple M2 Max, 32GB RAM, macOS 14.0
              </p>
              {isLive && (
                <p className="text-xs text-emerald-400 mt-2 flex items-center justify-center gap-1">
                  <Radio className="w-3 h-3" />
                  Live from /api/benchmarks
                </p>
              )}
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
