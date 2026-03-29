#!/bin/bash
cd "$(dirname "$0")"
set -a && source .env && set +a
echo "Starting Anthropic bridge on port ${PORT:-8082}..."
exec node server.mjs
