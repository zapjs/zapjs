# Deployment

This guide covers building and deploying Zap.js applications for production.

## Production Build

### Build Command

```bash
zap build
```

This creates a `dist/` directory:

```
dist/
├── bin/
│   └── zap              # Rust binary (~4MB)
├── static/              # Frontend assets
│   ├── index.html
│   └── assets/
│       ├── index-abc123.js
│       └── index-def456.css
├── config.json          # Server configuration
└── manifest.json        # Build metadata
```

### Build Options

```bash
# Custom output directory
zap build --output ./build

# Cross-compile for Linux
zap build --target x86_64-unknown-linux-gnu

# Skip frontend (API-only server)
zap build --skip-frontend

# Skip Rust (frontend-only update)
zap build --skip-rust
```

### Build Targets

Common targets for cross-compilation:

| Target | Platform |
|--------|----------|
| `x86_64-unknown-linux-gnu` | Linux x64 |
| `aarch64-unknown-linux-gnu` | Linux ARM64 |
| `x86_64-apple-darwin` | macOS x64 |
| `aarch64-apple-darwin` | macOS ARM64 |
| `x86_64-pc-windows-msvc` | Windows x64 |

Install target:

```bash
rustup target add x86_64-unknown-linux-gnu
```

## Running Production Server

### Basic

```bash
cd dist
./bin/zap
```

### With Options

```bash
./bin/zap --port 8080 --host 0.0.0.0
```

### Using CLI

```bash
zap serve --port 8080
```

## Docker Deployment

### Dockerfile

```dockerfile
# Build stage
FROM rust:1.75-slim as builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Copy source
COPY . .

# Build
RUN npm install
RUN npm run build

# Runtime stage
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy built files
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3000

# Run
CMD ["./dist/bin/zap", "--port", "3000", "--host", "0.0.0.0"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Build and Run

```bash
# Build image
docker build -t my-zap-app .

# Run container
docker run -p 3000:3000 my-zap-app

# With docker-compose
docker-compose up -d
```

## Environment Configuration

### Environment Variables

```bash
# Server configuration
ZAP_PORT=3000
ZAP_HOST=0.0.0.0
ZAP_LOG_LEVEL=info

# Application secrets
DATABASE_URL=postgres://...
JWT_SECRET=your-secret-key
```

### Config File

**`dist/config.json`**

```json
{
  "port": 3000,
  "hostname": "0.0.0.0",
  "ipc_socket_path": "/tmp/zap.sock",
  "max_request_body_size": 10485760,
  "request_timeout_secs": 30,
  "keepalive_timeout_secs": 60,
  "middleware": {
    "enable_cors": true,
    "enable_logging": true,
    "enable_compression": true
  },
  "health_check_path": "/health",
  "static_files": [
    {
      "prefix": "/",
      "directory": "./static"
    }
  ]
}
```

### Runtime Override

```bash
./bin/zap --config ./custom-config.json --port 8080
```

## Cloud Deployment

### Fly.io

**`fly.toml`**

```toml
app = "my-zap-app"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1

[env]
  NODE_ENV = "production"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
```

```bash
fly launch
fly deploy
```

### Railway

**`railway.toml`**

```toml
[build]
builder = "dockerfile"

[deploy]
startCommand = "./dist/bin/zap --port $PORT --host 0.0.0.0"
healthcheckPath = "/health"
healthcheckTimeout = 100
```

### Render

**`render.yaml`**

```yaml
services:
  - type: web
    name: my-zap-app
    runtime: docker
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 3000
```

## Reverse Proxy

### Nginx

```nginx
upstream zap_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://zap_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Caddy

```caddyfile
example.com {
    reverse_proxy localhost:3000
}
```

## Process Management

### systemd

**`/etc/systemd/system/zap-app.service`**

```ini
[Unit]
Description=Zap.js Application
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/my-app/dist
ExecStart=/var/www/my-app/dist/bin/zap --port 3000
Restart=always
RestartSec=10

Environment=NODE_ENV=production
Environment=DATABASE_URL=postgres://...

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable zap-app
sudo systemctl start zap-app
sudo systemctl status zap-app
```

### PM2 (with Node.js wrapper)

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'zap-app',
    script: './dist/bin/zap',
    args: '--port 3000',
    cwd: '/var/www/my-app',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Health Checks

The built-in health endpoint:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Configure in your deployment:

```yaml
# Kubernetes
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

## Logging

### Log Levels

```bash
./bin/zap --log-level debug   # Verbose
./bin/zap --log-level info    # Default
./bin/zap --log-level warn    # Warnings and errors
./bin/zap --log-level error   # Errors only
```

### Log Output

```
[2024-01-01T00:00:00Z] INFO  zap: Starting server on 0.0.0.0:3000
[2024-01-01T00:00:01Z] INFO  zap: GET /api/users 200 12ms
[2024-01-01T00:00:02Z] ERROR zap: POST /api/users 500 Internal Server Error
```

### Log Aggregation

Forward logs to aggregation services:

```bash
./bin/zap 2>&1 | tee /var/log/zap-app.log

# With journald
journalctl -u zap-app -f
```

## Security Checklist

- [ ] Enable HTTPS (use reverse proxy)
- [ ] Set secure headers (CORS, CSP)
- [ ] Use environment variables for secrets
- [ ] Enable request body size limits
- [ ] Set request timeouts
- [ ] Run as non-root user
- [ ] Keep dependencies updated
- [ ] Enable health checks
- [ ] Set up monitoring and alerts

## Performance Tips

### Binary Optimization

```toml
# Cargo.toml
[profile.release]
lto = "fat"           # Link-time optimization
codegen-units = 1     # Single codegen unit
panic = "abort"       # Smaller binary
opt-level = 3         # Maximum optimization
strip = true          # Strip symbols
```

### Server Tuning

```json
{
  "max_request_body_size": 10485760,
  "request_timeout_secs": 30,
  "keepalive_timeout_secs": 60
}
```

### Static Assets

- Enable compression in config
- Use CDN for static files
- Set cache headers

---

## See Also

- [CLI Reference](../api/cli.md) - Build and serve commands
- [Architecture](../ARCHITECTURE.md) - System design
- [Performance](../internals/performance.md) - Optimization details
