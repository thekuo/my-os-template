#!/bin/sh
# One-time production setup for my-os. Run from the app/ directory.
set -e
cd "$(dirname "$0")"
if grep -q "<YOUR_D1_DATABASE_ID>" wrangler.toml; then
  ID=$(npx wrangler d1 create my-os 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)
  sed -i.bak "s/<YOUR_D1_DATABASE_ID>/$ID/" wrangler.toml && rm -f wrangler.toml.bak
  npx wrangler d1 execute my-os --remote --file=schema.sql
  npx wrangler d1 execute my-os --remote --file=seed.sql
fi
npx wrangler deploy
echo "Now set your passphrase:  npx wrangler secret put APP_PASSPHRASE"
