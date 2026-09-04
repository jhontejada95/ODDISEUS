# ODDISEUS

ODDISEUS is a testnet clearing layer for financial AI agents built for the Binance Agent OS Mini Hackathon, Track B.

It is not a trading bot. It is infrastructure for agentic finance: agents can request live market reads, optional external intelligence, policy checks, human approval, Binance Spot Testnet execution, receipts, and reputation updates.

## No-Mock Policy

ODDISEUS must not present simulated infrastructure as real infrastructure.

The working rule is captured in [`NO_MOCK_CONTRACT.md`](./NO_MOCK_CONTRACT.md). Runtime truth is exposed through `/api/config` and `/api/health`; the frontend should not invent operational values that are not returned by the backend or a run payload.

Current real lanes:

- Live Binance Spot/Futures Testnet market reads.
- Signed Binance Spot Testnet order placement when the testnet API key, secret, and execution flag are configured.
- Deterministic risk and policy checks computed from the captured run state.
- Operator approval hash and verifiable receipt hash.

Explicitly not claimed until configured:

- B402/x402 paid-intelligence settlement. If `B402_TESTNET_ENDPOINT` is missing, the run records `not_configured` and does not fabricate paid data.
- MCP execution transport. The current execution adapter is Binance Spot Testnet REST.
- Wallet signatures, on-chain anchoring, or mainnet execution.

## Core Demo Flow

```text
intent -> Binance testnet data -> external-intel connector check -> risk engine -> policy engine -> approval -> testnet execution -> receipt
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
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
VITE_WALLETCONNECT_PROJECT_ID
ODDISEUS_ONCHAIN_ANCHOR_ENDPOINT
```

Keep the deployment testnet-only. Do not add mainnet keys or real-fund credentials.

### Durable state

ODDISEUS supports durable run and receipt storage through Upstash Redis REST. Install Upstash Redis from the Vercel Marketplace or add these variables manually:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

When those variables are present, `/api/config` reports persistence as `live` and the backend writes:

- `oddiseus:run:<runId>`
- `oddiseus:receipt:<runId>`
- sorted index `oddiseus:runs`

Without Redis, ODDISEUS keeps a serverless-safe fallback that restores run state from the client payload, but `/api/config` reports persistence as `not_configured` instead of pretending durable storage exists.

### Wallet approvals

ODDISEUS requires an EVM wallet signature before execution. The backend creates a canonical approval challenge, the wallet signs it, and the backend verifies the signature with `viem` before moving a run from `approval` to `execution`.

Injected EVM wallets such as MetaMask, Rabby, Binance Wallet, and compatible browser wallets work without additional env vars. For WalletConnect QR/mobile support, add:

```text
VITE_WALLETCONNECT_PROJECT_ID
```

## Submission

- Project: ODDISEUS
- Track: Track B - Connect your Agent to MCP
- X handle: `https://x.com/0xjh0n`
- Deadline: 2026-09-08 23:59 UTC
