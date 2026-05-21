#!/bin/bash

# Exit on any error
set -e

echo "📦 Building @multiplayer-app/cli..."
bun run scripts/build.ts "$@"
echo "✅ Build complete!"
