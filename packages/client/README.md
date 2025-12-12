# @zap-js/client

Client-side package for the ZapJS fullstack React framework.

## Installation

```bash
npm install @zap-js/client
```

## Usage

```javascript
import { router, middleware, errors, logger } from '@zap-js/client'

// Router components and hooks
const { Link, useRouter, useParams } = router

// Middleware functions
const { requireAuth, preloadData } = middleware

// Error handling
const { ErrorBoundary } = errors

// Logging
const log = logger.create('MyApp')
```

## Features

- **File-based routing** with automatic route generation
- **Nested layouts** with `_layout.tsx` files
- **Route-level middleware** for auth and data preloading
- **Zero-config development** with hot module reload
- **TypeScript support** out of the box
- **Production optimizations** built-in

## Documentation

Full documentation available at [https://github.com/saint0x/zapjs](https://github.com/saint0x/zapjs)

## License

MIT