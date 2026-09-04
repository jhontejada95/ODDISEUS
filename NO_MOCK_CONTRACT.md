# ODDISEUS No-Mock Contract

Golden rule: ODDISEUS must never present simulated infrastructure as real infrastructure.

Every visible capability must be one of:

- `live` — connected to a real source, service, credential, endpoint, or signed testnet action.
- `blocked` — intentionally stopped by policy, missing approval, risk, or failed upstream execution.
- `not_configured` — planned but not connected yet.
- `pending` — waiting for the current run to reach that stage.

## Current live capabilities

- Binance Spot Testnet market reads.
- Binance Futures Testnet market reads.
- Signed Binance Spot Testnet execution when testnet credentials and `ODDISEUS_ENABLE_TESTNET_EXECUTION=true` are configured.
- Deterministic policy/risk evaluation from captured run state.
- Operator approval hash.
- Receipt hash generation.

## Current not-configured capabilities

- Binance MCP transport.
- B402/x402 external-intelligence settlement unless `B402_TESTNET_ENDPOINT` is set.
- Wallet approval signatures unless `ODDISEUS_ENABLE_WALLET_SIGNATURES=true` and a real wallet flow exists.
- Receipt on-chain anchoring unless `ODDISEUS_ONCHAIN_ANCHOR_ENDPOINT` is set.
- Durable run/receipt persistence unless `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured.

## Implementation rule

Frontend copy must derive operational values from `/api/config`, `/api/health`, or a run payload. If a value cannot be traced to backend config, captured upstream data, policy output, user approval, execution response, or receipt hash, it must not be displayed as operational truth.

## Connection backlog

Any `not_configured` capability is a build target, not an acceptable final state. The current activation order is:

1. Durable persistence via Upstash Redis REST.
2. Wallet approval signatures.
3. MCP transport.
4. B402/x402 paid-intelligence endpoint.
5. Receipt anchoring.
