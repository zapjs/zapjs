#!/bin/bash

# ZapJS Publishing Script
# This script helps publish both @zap-js/client and @zap-js/server packages

set -e

echo "🚀 ZapJS Publishing Process"
echo "=========================="

# Check if we're in the root directory
if [ ! -f "package.json" ] || [ ! -d "packages" ]; then
  echo "❌ Error: Must be run from the ZapJS root directory"
  exit 1
fi

# Check npm login status
echo "Checking npm authentication..."
npm_user=$(npm whoami 2>/dev/null || echo "")
if [ -z "$npm_user" ]; then
  echo "❌ Error: Not logged in to npm. Run 'npm login' first"
  exit 1
fi
echo "✅ Logged in as: $npm_user"

# Build everything
echo -e "\n📦 Building packages..."
echo "Building TypeScript files..."
cd packages/client && npm run build && cd ../..
echo "✅ Client package built"

echo -e "\n🦀 Building Rust binaries..."
cargo build --release
echo "✅ Server binaries built"

# Run tests
echo -e "\n🧪 Running tests..."
cargo test
echo "✅ All tests passed"

# Check versions
echo -e "\n📋 Package versions:"
client_version=$(cd packages/client && node -p "require('./package.json').version")
server_version=$(cd packages/server && node -p "require('./package.json').version")
echo "  @zap-js/client: $client_version"
echo "  @zap-js/server: $server_version"

# Dry run first
echo -e "\n🔍 Running dry-run publish..."
cd packages/server && npm publish --dry-run && cd ../..
cd packages/client && npm publish --dry-run && cd ../..

# Confirm before actual publish
echo -e "\n⚠️  Ready to publish to npm!"
echo "This will publish:"
echo "  - @zap-js/client@${client_version}"
echo "  - @zap-js/server@${server_version}"
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Publishing cancelled"
  exit 1
fi

# Publish server first (since client might depend on it)
echo -e "\n📤 Publishing @zap-js/server..."
cd packages/server && npm publish && cd ../..
echo "✅ @zap-js/server published!"

# Publish client
echo -e "\n📤 Publishing @zap-js/client..."
cd packages/client && npm publish && cd ../..
echo "✅ @zap-js/client published!"

echo -e "\n🎉 Successfully published both packages!"
echo "Users can now install with:"
echo "  npm install @zap-js/client @zap-js/server"