#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir dist
