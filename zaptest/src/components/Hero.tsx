import { motion, useScroll, useTransform } from 'framer-motion';
import { useRef } from 'react';
import { ArrowRight, Zap, Terminal, Sparkles } from 'lucide-react';

export default function Hero() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end start'],
  });

  const y = useTransform(scrollYProgress, [0, 1], ['0%', '50%']);
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 0.5], [1, 0.9]);

  return (
    <section
      ref={containerRef}
      className="relative min-h-screen flex items-center justify-center pt-20 overflow-hidden"
    >
      {/* Hero content */}
      <motion.div
        style={{ y, opacity, scale }}
        className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 sm:py-32"
      >
        <div className="text-center max-w-5xl mx-auto">
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="inline-flex items-center gap-2 px-4 py-2 mb-8 bg-carbon-900/50 backdrop-blur-sm border border-carbon-800 rounded-full"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-sm text-carbon-300">
              This website is a <span className="text-zap-400 font-medium">ZapJS</span> project
            </span>
          </motion.div>

          {/* Main heading */}
          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.1 }}
            className="font-display font-black text-5xl sm:text-6xl md:text-7xl lg:text-8xl tracking-tight"
          >
            <span className="block text-white">Fullstack at the</span>
            <span className="block mt-2">
              <span className="text-gradient">Speed of Rust</span>
            </span>
          </motion.h1>

          {/* Subheading */}
          <motion.p
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="mt-8 text-lg sm:text-xl md:text-2xl text-carbon-400 max-w-3xl mx-auto leading-relaxed"
          >
            <span className="text-rust-400 font-medium">Rust</span> server,{' '}
            <span className="text-sky-400 font-medium">React</span> frontend,{' '}
            <span className="text-zap-400 font-medium">zero</span> glue code.
            Auto-generated TypeScript bindings from your Rust handlers.
          </motion.p>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="mt-12 flex flex-wrap items-center justify-center gap-8 sm:gap-12"
          >
            {[
              { value: '20ns', label: 'Route Lookup' },
              { value: '<1ms', label: 'Response Time' },
              { value: '~4MB', label: 'Binary Size' },
            ].map((stat, i) => (
              <div key={i} className="text-center">
                <div className="font-display font-bold text-3xl sm:text-4xl text-white">
                  {stat.value}
                </div>
                <div className="text-sm text-carbon-500 mt-1">{stat.label}</div>
              </div>
            ))}
          </motion.div>

          {/* CTA Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <motion.a
              href="#get-started"
              className="group relative inline-flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-zap-500 to-zap-600 text-white font-semibold rounded-full shadow-xl shadow-zap-500/25 overflow-hidden"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <span className="relative z-10 flex items-center gap-2">
                <Sparkles className="w-5 h-5" />
                Get Started
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </span>
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-zap-400 to-zap-500"
                initial={{ x: '100%' }}
                whileHover={{ x: 0 }}
                transition={{ duration: 0.3 }}
              />
            </motion.a>

            <motion.a
              href="#code"
              className="group inline-flex items-center gap-2 px-8 py-4 bg-carbon-900/50 backdrop-blur-sm border border-carbon-700 text-white font-medium rounded-full hover:bg-carbon-800/50 hover:border-carbon-600 transition-all"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <Terminal className="w-5 h-5 text-carbon-400 group-hover:text-zap-400 transition-colors" />
              View Examples
            </motion.a>
          </motion.div>

          {/* Quick install */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            className="mt-12"
          >
            <div className="inline-flex items-center gap-3 px-6 py-3 bg-carbon-900/80 backdrop-blur-sm border border-carbon-800 rounded-xl">
              <span className="text-carbon-500 text-sm">$</span>
              <code className="font-mono text-sm sm:text-base text-carbon-200">
                npx create-zap-app my-app
              </code>
              <button
                onClick={() => navigator.clipboard.writeText('npx create-zap-app my-app')}
                className="px-3 py-1 text-xs font-medium text-carbon-400 hover:text-white bg-carbon-800 hover:bg-carbon-700 rounded-md transition-colors"
              >
                Copy
              </button>
            </div>
          </motion.div>
        </div>
      </motion.div>

      {/* Decorative elements */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-carbon-950 to-transparent pointer-events-none" />

      {/* Floating icons */}
      <motion.div
        animate={{
          y: [0, -20, 0],
          rotate: [0, 5, 0],
        }}
        transition={{
          duration: 6,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
        className="absolute top-1/4 left-[15%] hidden lg:block"
      >
        <div className="w-16 h-16 bg-gradient-to-br from-rust-400/20 to-rust-600/20 rounded-2xl flex items-center justify-center backdrop-blur-sm border border-rust-500/20">
          <svg viewBox="0 0 24 24" className="w-8 h-8 text-rust-400" fill="currentColor">
            <path d="M23.687 11.709l-2.5-4.344c-.17-.295-.5-.477-.857-.477h-5.33L12.854 3.21a1 1 0 00-1.708 0L9 6.888H3.67c-.357 0-.687.182-.857.477l-2.5 4.344a1 1 0 000 1l2.5 4.344c.17.295.5.477.857.477h5.33l2.146 3.678a1 1 0 001.708 0L15 17.53h5.33c.357 0 .687-.182.857-.477l2.5-4.344a1 1 0 000-1z"/>
          </svg>
        </div>
      </motion.div>

      <motion.div
        animate={{
          y: [0, 20, 0],
          rotate: [0, -5, 0],
        }}
        transition={{
          duration: 5,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: 1,
        }}
        className="absolute top-1/3 right-[15%] hidden lg:block"
      >
        <div className="w-14 h-14 bg-gradient-to-br from-sky-400/20 to-sky-600/20 rounded-2xl flex items-center justify-center backdrop-blur-sm border border-sky-500/20">
          <svg viewBox="0 0 24 24" className="w-7 h-7 text-sky-400" fill="currentColor">
            <path d="M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38a2.167 2.167 0 0 0-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44a23.476 23.476 0 0 0-3.107-.534A23.892 23.892 0 0 0 12.769 4.7c1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442a22.73 22.73 0 0 0-3.113.538 15.02 15.02 0 0 1-.254-1.42c-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.127z"/>
          </svg>
        </div>
      </motion.div>

      <motion.div
        animate={{
          y: [0, -15, 0],
          x: [0, 10, 0],
        }}
        transition={{
          duration: 7,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: 2,
        }}
        className="absolute bottom-1/3 left-[20%] hidden lg:block"
      >
        <div className="w-12 h-12 bg-gradient-to-br from-zap-400/20 to-zap-600/20 rounded-xl flex items-center justify-center backdrop-blur-sm border border-zap-500/20">
          <Zap className="w-6 h-6 text-zap-400" fill="currentColor" />
        </div>
      </motion.div>
    </section>
  );
}
