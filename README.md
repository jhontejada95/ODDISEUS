# ODDISEUS

ODDISEUS is a testnet clearing layer for financial AI agents built for the Binance Agent OS Mini Hackathon, Track B.

It is not a trading bot. It is infrastructure for agentic finance: agents can request market reads, paid intelligence, policy checks, human approval, Binance testnet execution, receipts, and reputation updates.

## Core Demo Flow

```text
intent -> Binance testnet data -> paid intelligence -> risk agent -> policy engine -> approval -> testnet execution -> receipt
```

## Testnet-Only Rule

ODDISEUS is designed for testnet execution only during the hackathon. Mainnet trading, withdrawals, leverage, custody of user private keys, and profit claims are out of scope.

Real Binance Spot Testnet execution requires:

```text
BINANCE_TESTNET_API_KEY=
BINANCE_TESTNET_API_SECRET=
ODDISEUS_ENABLE_TESTNET_EXECUTION=true
```

Without those values, the execution stage records a verifiable block instead of pretending an order happened.

## Development

```bash
npm install
npm run build
npm run server
```

Then open `http://127.0.0.1:5173`.

During active development, use:

```bash
npm run dev
```

## GitHub + Vercel Deployment

ODDISEUS is prepared for GitHub and Vercel deployment.

Important: never commit `.env`. The repository includes `.gitignore` and `.vercelignore` so local secrets stay out of source control and deploy bundles.

### 1. Create the GitHub repo

Create an empty GitHub repository, then run from this folder:

```bash
git init
git add .
git commit -m "Initial ODDISEUS testnet clearing layer"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

### 2. Import into Vercel

In Vercel:

1. Import the GitHub repository.
2. Keep the project root as the repository root.
3. Use the default install/build settings:
   - Install command: `npm install`
   - Build command: `npm run build`
   - Output directory: `dist`

The root `server.js` exports the Express app for local/Vercel compatibility. The `api/[...path].js` catch-all mounts the same Express app under `/api/*` when the project is imported with Vercel's Vite preset.

`vercel.json` pins Functions to `gru1` (São Paulo, Brazil) because Binance may reject requests from US regions such as `iad1`. The frontend remains globally served by Vercel's CDN; the API functions should run from the configured region.

### 3. Add Vercel environment variables

Set these in Vercel Project Settings → Environment Variables:

```text
BINANCE_TESTNET_API_KEY
BINANCE_TESTNET_API_SECRET
BINANCE_TESTNET_BASE_URL=https://testnet.binance.vision
BINANCE_FUTURES_TESTNET_BASE_URL=https://demo-fapi.binance.com
ODDISEUS_DEFAULT_SYMBOL=BTCUSDT
ODDISEUS_ENABLE_TESTNET_EXECUTION=true
```

Optional:

```text
B402_TESTNET_ENDPOINT
```

Keep the deployment testnet-only. Do not add mainnet keys or real-fund credentials.

### Serverless state note

The current MVP stores run state in memory. That is acceptable for a hackathon demo and short test sessions, but production infrastructure should move run state and receipts to durable storage such as Redis, Vercel KV, Postgres, or Supabase.

## Submission

- Project: ODDISEUS
- Track: Track B - Connect your Agent to MCP
- X handle: `https://x.com/0xjh0n`
- Deadline: 2026-09-08 23:59 UTC
