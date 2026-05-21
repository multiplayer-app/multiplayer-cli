#!/bin/bash

# Exit on any error
set -e

echo "🚀 Publishing @multiplayer-app/cli..."
bun run scripts/publish.ts "$@"
echo "✅ Publish complete!"