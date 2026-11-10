# Bomberman Online stats collector

This Cloudflare Worker polls DCNet's public player feed once per minute and records **only** rows whose exact game ID is \`bomberman\`.

## What it records

- Unique DCNet account identities observed after collection starts.
- Current and peak concurrent Bomberman player counts.
- Daily unique players for the last 30 days.
- Approximate sessions. A new session is counted after at least 10 minutes without an observation.
- First-seen and last-seen timestamps.

The collector uses a stable account ID if the feed provides one, otherwise \`loginName\` or \`name\`, to derive an HMAC-SHA-256 pseudonym. It never stores raw player names. Keep \`PLAYER_HASH_SECRET\` private and unchanged; rotating it makes previous identities appear new.

## One-time Cloudflare setup

Install Node.js, then from this directory:

\`\`\`sh
npx wrangler login
npx wrangler d1 create bomberman-online-stats
\`\`\`

Copy the returned \`database_id\` into \`database_id\` in \`wrangler.toml\`.

Initialize the remote database:

\`\`\`sh
npx wrangler d1 execute bomberman-online-stats --remote --file=./schema.sql
\`\`\`

Set a private HMAC key (never commit it or put it in the website):

\`\`\`sh
openssl rand -hex 32 | npx wrangler secret put PLAYER_HASH_SECRET
\`\`\`

Deploy:

\`\`\`sh
npx wrangler deploy
\`\`\`

Wrangler prints a URL similar to \`https://bomberman-online-stats.<your-account-subdomain>.workers.dev\`. Test it:

\`\`\`sh
curl https://bomberman-online-stats.<your-account-subdomain>.workers.dev/health
curl https://bomberman-online-stats.<your-account-subdomain>.workers.dev/api/stats
\`\`\`

The scheduled trigger runs every minute. The collector starts recording when its first scheduled run succeeds.

## Connect the homepage

In the root \`index.html\`, find:

\`\`\`js
const STATS_API_BASE = "";
\`\`\`

Replace the empty string with your deployed Worker URL (no trailing slash), then commit and push. The GitHub Pages workflow publishes the homepage automatically.

## Accuracy and privacy

- Only exact game ID \`bomberman\` is counted; other DCNet games are ignored.
- Unique players means distinct account identities observed, not verified individual humans.
- DCNet's \`/players\` endpoint is a live snapshot, not a historical archive. Tracking starts on deployment. A player who connects and disconnects between minute polls may be missed.
- If DCNet exposes only a display name for an account, a name change may count as a new identity.
- Sessions are estimates: a new session is counted after a 10-minute gap.
- The site shows short pseudonymous player codes, never usernames.
- Do not rotate \`PLAYER_HASH_SECRET\` after tracking starts.
- The public API is read-only and exposes aggregate stats and pseudonymous codes only.
