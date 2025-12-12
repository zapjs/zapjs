# @zap-js/server

Server-side package for the ZapJS fullstack React framework with Rust-powered backend.

## Installation

```bash
npm install @zap-js/server
```

## Usage

```javascript
import { rpc, ipc } from '@zap-js/server'

// Call Rust backend functions
const result = await rpc.call('getUser', { id: 123 })

// Direct IPC communication
const client = new ipc.Client('/tmp/zap.sock')
```

## Features

- **Rust-powered backend** with 9ns route matching
- **Automatic TypeScript bindings** for Rust functions
- **Zero-overhead RPC** communication
- **Type-safe** end-to-end

## API Routes

Use server exports in your API route handlers:

```javascript
// routes/api/users.ts
import { rpc } from '@zap-js/server'

export const GET = async (req) => {
  return await rpc.call('list_users', {
    limit: req.query.limit || 10
  })
}
```

## Documentation

Full documentation available at [https://github.com/saint0x/zapjs](https://github.com/saint0x/zapjs)

## License

MIT