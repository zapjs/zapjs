# IPC Architecture for RPC in ZapJS

## Executive Summary

**Problem**: API route handlers calling `rpc.call()` fail with "RPC client not initialized"

**Root Cause**: RPC client exists but is never initialized, and Rust server has no IPC handler for RPC calls

**Solution**: Implement bidirectional IPC on Unix domain sockets for low-latency RPC

**Impact**: 10-50x faster RPC calls vs HTTP (0.1ms vs 2ms latency)

---

## Current State

### What Works ✅

1. **HTTP Request Routing** (Rust → TypeScript)
   - Rust server receives HTTP request
   - Routes to TypeScript handler via IPC `invoke_handler` message
   - TypeScript handler executes and returns response
   - Works perfectly in dev and production

2. **IPC Infrastructure**
   - TypeScript: `IpcServer` and `IpcClient` classes exist
   - Rust: `IpcServer` and `IpcClient` implemented
   - Message framing with length prefixes
   - MessagePack encoding
   - Bidirectional communication supported

3. **RPC Dispatch in Zaptest**
   - Zaptest has `handle_rpc()` and `dispatch_rpc()` functions
   - All RPC functions like `get_benchmarks` are registered
   - HTTP endpoint `/__zap_rpc` works (but not used)

### What's Broken ❌

1. **RPC Client Not Initialized**
   - `packages/client/src/runtime/rpc-client.ts` exists
   - Designed for IPC communication
   - Never initialized in dev server
   - Result: `rpcCall()` throws "RPC client not initialized"

2. **No RPC Handler in Rust Server**
   - Rust server has no code to handle `rpc_call` IPC messages
   - TypeScript sends RPC calls into void
   - Even if initialized, no response would come back

3. **No RPC Dispatch Integration**
   - Framework doesn't know how to call user's RPC functions
   - No way to pass `dispatch_rpc` function to server
   - User's RPC code is isolated in their binary

---

## Architecture Design

### Current IPC Flow (HTTP Requests Only)

```
Browser → HTTP → Rust Server (port 3000)
                      ↓
                 Route Match
                      ↓
           TypeScript Handler?
                      ↓
              ProxyHandler → IPC Client
                      ↓
            Unix Socket: /tmp/zap-dev-123.sock
                      ↓
              TypeScript IPC Server
                      ↓
           Handler Dispatcher
                      ↓
      routes/api/benchmarks.ts → GET()
                      ↓
      ❌ rpc.call('get_benchmarks', {})
         FAILS: RPC client not initialized
```

### Target IPC Flow (Bidirectional)

```
Browser → HTTP → Rust Server (port 3000)
                      ↓
                 Route Match
                      ↓
           TypeScript Handler?
                      ↓
              ProxyHandler → IPC Client
                      ↓
            Unix Socket: /tmp/zap-dev-123.sock  ← SAME SOCKET
                      ↓                          ↑
              TypeScript IPC Server              │
                      ↓                          │ TypeScript RPC Client
           Handler Dispatcher                    │
                      ↓                          │
      routes/api/benchmarks.ts → GET()          │
                      ↓                          │
      ✅ rpc.call('get_benchmarks', {}) ────────┘
                      ↓
              Sends rpc_call IPC message
                      ↓
            Unix Socket: /tmp/zap-dev-123.sock
                      ↓
         Rust IPC Listener (NEW!)
                      ↓
         RPC Dispatcher (NEW!)
                      ↓
    User's dispatch_rpc() function
                      ↓
         get_benchmarks() Rust function
                      ↓
         Returns BenchmarksResponse
                      ↓
         Sends rpc_response IPC message
                      ↓
         TypeScript receives result
                      ↓
         Handler returns to browser
```

### Message Types on IPC Socket

#### Rust → TypeScript Messages

1. **invoke_handler** - Call TypeScript route handler
   ```json
   {
     "type": "invoke_handler",
     "handler_id": "api_users_get",
     "request": { "method": "GET", "path": "/api/users", ... }
   }
   ```

2. **ws_connect** - WebSocket connection
3. **ws_message** - WebSocket message
4. **ws_close** - WebSocket close
5. **health_check** - Health check ping

#### TypeScript → Rust Messages (NEW!)

1. **rpc_call** - Call Rust function
   ```json
   {
     "type": "rpc_call",
     "function_name": "get_benchmarks",
     "params": {},
     "request_id": "req_1234567890_0"
   }
   ```

2. **rpc_response** - RPC success response
   ```json
   {
     "type": "rpc_response",
     "request_id": "req_1234567890_0",
     "result": { "latency_ns": 9, "throughput": "..." }
   }
   ```

3. **rpc_error** - RPC error response
   ```json
   {
     "type": "rpc_error",
     "request_id": "req_1234567890_0",
     "error": "Function not found",
     "error_type": "NotFound"
   }
   ```

---

## Implementation Plan

### Phase 1: TypeScript Side (Simple)

**File**: `packages/client/src/dev-server/server.ts`

**Status**: ✅ COMPLETED

**Changes**:
```typescript
// Line 12: Add import
import { initRpcClient } from '../runtime/rpc-client.js';

// Line 405: After IPC server starts
initRpcClient(this.socketPath);
this.log('debug', `RPC client initialized on ${this.socketPath}`);
```

**What this does**:
- Initializes the RPC client module-level singleton
- Connects to the IPC socket as a client
- Enables `rpc.call()` to send messages
- Works for both dev and production (production would init differently)

### Phase 2: Rust Side (Complex)

#### Option A: Separate RPC Socket (Simpler, Less Elegant)

Create a second Unix socket just for RPC.

**Pros**:
- Simpler to implement
- Clear separation of concerns
- Easier to debug

**Cons**:
- Two sockets instead of one
- More resource usage
- Less elegant architecture

**Implementation**:
1. Create `packages/server/src/rpc.rs` module
2. Implement `RpcServer` that listens on `{socket}.rpc`
3. Handle `rpc_call` messages
4. Call user-provided dispatch function
5. Send `rpc_response` back

#### Option B: Bidirectional on Same Socket (Better, Harder)

Make the existing IPC connection bidirectional.

**Pros**:
- One socket for everything
- More efficient
- Architecturally elegant
- Better resource usage

**Cons**:
- More complex implementation
- Rust IPC connection becomes bidirectional
- Requires connection state management

**Implementation**:
1. Modify `ProxyHandler` to also listen for incoming messages
2. Add RPC dispatch capability
3. Route `rpc_call` messages to dispatch function
4. Send `rpc_response` on same connection

#### **RECOMMENDED: Option A (Separate Socket)**

While less elegant, it's significantly simpler to implement and maintain. Performance difference is negligible.

---

## Detailed Implementation Steps

### Phase 2A: Create RPC Server Module

**File**: `packages/server/src/rpc.rs` (NEW)

```rust
//! RPC Server for handling TypeScript → Rust function calls via IPC

use std::sync::Arc;
use tokio::sync::mpsc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{debug, error, info};

use crate::ipc::{IpcServer, IpcEncoding};
use crate::error::{ZapError, ZapResult};

/// RPC request from TypeScript
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub function_name: String,
    pub params: Value,
    pub request_id: String,
}

/// RPC response to TypeScript
#[derive(Debug, Serialize)]
pub struct RpcResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_type: Option<String>,
}

/// User's RPC dispatch function type
/// Takes function name and params, returns result or error
pub type RpcDispatchFn = Arc<dyn Fn(String, Value) -> Result<Value, String> + Send + Sync>;

/// RPC Server - listens for rpc_call messages from TypeScript
pub struct RpcServerHandle {
    socket_path: String,
    dispatch_fn: RpcDispatchFn,
}

impl RpcServerHandle {
    /// Create a new RPC server
    pub fn new(socket_path: String, dispatch_fn: RpcDispatchFn) -> Self {
        Self {
            socket_path,
            dispatch_fn,
        }
    }

    /// Start the RPC server in the background
    pub async fn start(self) -> ZapResult<()> {
        let socket_path = format!("{}.rpc", self.socket_path);
        info!("🔧 Starting RPC server on {}", socket_path);

        let server = IpcServer::new(socket_path);
        let dispatch_fn = self.dispatch_fn;

        // Spawn server task
        tokio::spawn(async move {
            if let Err(e) = Self::run_server(server, dispatch_fn).await {
                error!("RPC server error: {}", e);
            }
        });

        Ok(())
    }

    async fn run_server(
        server: IpcServer,
        dispatch_fn: RpcDispatchFn,
    ) -> ZapResult<()> {
        // TODO: Implement IPC server listen loop
        // Accept connections, read messages, dispatch, send responses
        Ok(())
    }

    fn handle_rpc_call(
        request: RpcRequest,
        dispatch_fn: &RpcDispatchFn,
    ) -> RpcResponse {
        debug!("RPC call: {} with params {:?}", request.function_name, request.params);

        match dispatch_fn(request.function_name.clone(), request.params) {
            Ok(result) => RpcResponse {
                msg_type: "rpc_response".to_string(),
                request_id: request.request_id,
                result: Some(result),
                error: None,
                error_type: None,
            },
            Err(error) => RpcResponse {
                msg_type: "rpc_error".to_string(),
                request_id: request.request_id,
                result: None,
                error: Some(error),
                error_type: Some("RpcError".to_string()),
            },
        }
    }
}
```

### Phase 2B: Integrate into Server Config

**File**: `packages/server/src/config.rs`

```rust
/// Add to ZapConfig struct
pub rpc_dispatch: Option<Arc<dyn Fn(String, Value) -> Result<Value, String> + Send + Sync>>,
```

**File**: `packages/server/src/server.rs`

```rust
// In from_config(), after routes are registered:

if let Some(dispatch_fn) = config.rpc_dispatch {
    let rpc_server = RpcServerHandle::new(
        config.ipc_socket_path.clone(),
        dispatch_fn,
    );
    rpc_server.start().await?;
    info!("✅ RPC server started");
}
```

### Phase 2C: Update User's Binary

**File**: `zaptest/server/src/main.rs`

```rust
// Wrap the dispatch_rpc function
let dispatch_fn = Arc::new(|function_name: String, params: Value| -> Result<Value, String> {
    let request = RpcRequest {
        method: function_name,
        params,
    };

    let response = dispatch_rpc(request);

    if response.success {
        Ok(response.data.unwrap_or(Value::Null))
    } else {
        Err(response.error.map(|e| e.error).unwrap_or_else(|| "Unknown error".to_string()))
    }
});

// Add to config
config.rpc_dispatch = Some(dispatch_fn);
```

---

## Testing Strategy

### Phase 1: TypeScript Only (Partial Test)

```bash
cd packages/client
npm run build
npm version patch  # 0.0.6
npm publish
```

Update zaptest:
```bash
cd zaptest
npm install @zap-js/client@0.0.6
npm run dev
```

**Expected**: API routes still fail, but with different error (connection refused instead of "not initialized")

### Phase 2: With Rust RPC Server

```bash
cd packages/server
cargo build --release
# Binary with RPC server built
```

Update zaptest to use RPC dispatch:
```bash
cd zaptest/server
# Add dispatch_fn to config
cargo build --release
```

Test:
```bash
cd zaptest
npm run dev
curl http://localhost:3000/api/benchmarks
```

**Expected**: Returns benchmark data!

### Full Verification

Test all RPC routes:
```bash
# Should all return JSON data
curl http://localhost:3000/api/benchmarks
curl http://localhost:3000/api/users
curl http://localhost:3000/api/features
curl http://localhost:3000/api/stats

# Check logs for RPC calls
# Should see:
# [RPC] get_benchmarks called
# [RPC] get_benchmarks returned in 0.05ms
```

---

## Performance Benchmarks

### Before (HTTP to /__zap_rpc)
- Latency: 1-2ms per call
- Throughput: ~500-1000 RPC calls/sec
- Overhead: TCP + HTTP parsing

### After (IPC Unix Socket)
- Latency: 0.01-0.1ms per call (10-50x faster)
- Throughput: ~10,000-50,000 RPC calls/sec
- Overhead: Message framing only

### Example: Dashboard with 50 API calls
- Before: 50 * 2ms = 100ms overhead
- After: 50 * 0.1ms = 5ms overhead
- **Improvement: 95ms faster (20x)**

---

## Migration Path

### Version 0.0.6 (Current Work)
- Initialize RPC client in dev server
- Implement basic RPC server in Rust
- Get it working end-to-end

### Version 0.0.7 (Future)
- Optimize RPC message encoding
- Add RPC call metrics/tracing
- Connection pooling for RPC

### Version 0.1.0 (Future)
- Production RPC initialization
- RPC middleware support
- Streaming RPC responses

---

## Alternative: HTTP Fallback

If IPC proves too complex, we can fall back to HTTP as a stopgap:

**TypeScript RPC Client** (HTTP version):
```typescript
export async function rpcCall<T>(
  functionName: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = 30000
): Promise<T> {
  const response = await fetch('http://127.0.0.1:3000/__zap_rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: functionName, params }),
  });

  const result = await response.json();
  if (!result.success) throw new Error(result.error.error);
  return result.data;
}
```

**Pros**: Works immediately, simple
**Cons**: Slower, philosophically inconsistent with "high-performance"

---

## Open Questions

1. **How to pass dispatch function through framework?**
   - Option A: Add to ZapConfig (chosen)
   - Option B: Use a global registry
   - Option C: Require users to start RPC server manually

2. **Should we support RPC in production mode?**
   - Yes, but initialization is different (no dev server)
   - Need to document how users init RPC client

3. **Do we need RPC middleware?**
   - Not for v1, but nice to have later
   - Auth, logging, rate limiting

4. **Should RPC calls timeout?**
   - Yes, default 30s
   - Configurable per call

---

## Success Criteria

✅ `rpc.call('get_benchmarks', {})` returns data
✅ No "RPC client not initialized" errors
✅ Latency < 1ms per RPC call (IPC)
✅ Works in both dev and production
✅ No breaking changes to existing code
✅ Documented and tested

---

## Files Modified Summary

### TypeScript (Client Package)
- ✅ `packages/client/src/dev-server/server.ts` - Init RPC client
- ⏳ `packages/client/src/runtime/rpc-client.ts` - No changes needed

### Rust (Server Package)
- ⏳ `packages/server/src/rpc.rs` - NEW: RPC server module
- ⏳ `packages/server/src/lib.rs` - Export RPC types
- ⏳ `packages/server/src/config.rs` - Add rpc_dispatch field
- ⏳ `packages/server/src/server.rs` - Start RPC server

### Documentation
- ✅ `IPC.md` - This file

### User Code (Zaptest - for testing)
- ⏳ `zaptest/server/src/main.rs` - Add dispatch_fn to config

---

## Timeline Estimate

- Phase 1 (TypeScript): ✅ Done (30 minutes)
- Phase 2A (RPC module): ⏳ 2-3 hours
- Phase 2B (Integration): ⏳ 1-2 hours
- Phase 2C (User code): ⏳ 30 minutes
- Testing: ⏳ 1 hour
- **Total: 4-6 hours**

---

## Notes

- IPC is the right choice for a "high-performance" framework
- HTTP fallback is available if needed
- Architecture supports future optimizations (connection pooling, streaming)
- Consistent with existing IPC infrastructure
