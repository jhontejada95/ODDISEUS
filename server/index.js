import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Redis } from "@upstash/redis";
import { verifyMessage } from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const app = express();
const runs = new Map();
let redisClient = null;

app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 5173);
const PRODUCT_VERSION = process.env.ODDISEUS_PRODUCT_VERSION || "0.9.13";
const TRUTH_MODE = "fail_closed_no_mock";
const DEFAULT_SYMBOL = process.env.ODDISEUS_DEFAULT_SYMBOL || "BTCUSDT";
const TESTNET_BASE_URL = normalizeBaseUrl(
  process.env.BINANCE_TESTNET_BASE_URL,
  "https://testnet.binance.vision"
);
const FUTURES_TESTNET_BASE_URL = normalizeBaseUrl(
  process.env.BINANCE_FUTURES_TESTNET_BASE_URL,
  "https://demo-fapi.binance.com"
);
const BINANCE_MCP_SERVER_URL = normalizeEndpointUrl(
  process.env.BINANCE_MCP_SERVER_URL,
  "https://agent.binance.com/mcp/agentic"
);
const BINANCE_MCP_ACCESS_TOKEN = normalizeSecretToken(
  process.env.BINANCE_MCP_ACCESS_TOKEN || process.env.BINANCE_AGENT_OS_MCP_TOKEN || ""
);
const MCP_OAUTH_CLIENT_METADATA_PATH = "/api/mcp-oauth/client-metadata";
const MCP_OAUTH_CALLBACK_PATH = "/api/mcp-oauth/callback";
const MCP_OAUTH_TOKEN_KEY = "oddiseus:mcp:binance:oauth:tokens";
const MCP_OAUTH_STATE_TTL_SECONDS = 10 * 60;
let mcpProbeCache = null;

const policy = {
  maxRunBudgetUsdt: 10,
  maxPaidDataUsdt: 0.25,
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  allowedActions: ["READ_MARKET", "EXTERNAL_INTEL", "TESTNET_SPOT"],
  realExecutionRequiresApproval: true,
  maxSpreadBps: 12,
  maxFundingRateAbs: 0.0005,
  denyIfAdlRisk: ["HIGH"],
  denyWithdrawals: true,
  denyLeverage: true,
  humanApprovalRef: "POL-HUM-08"
};

const stageOrder = [
  "intent",
  "market",
  "paid-data",
  "risk",
  "policy",
  "approval",
  "execution",
  "receipt"
];

app.get("/api/health", async (_req, res) => {
  const config = buildRuntimeConfig({ mcp: await probeBinanceMcp() });
  res.json({
    ok: true,
    service: "oddiseus",
    runtime: config.runtime.environment,
    vercelRegion: config.runtime.vercelRegion,
    truthMode: config.truthMode,
    binanceSpotBaseUrl: config.integrations.binanceSpot.baseUrl,
    binanceFuturesBaseUrl: config.integrations.binanceFutures.baseUrl,
    executionAdapter: config.integrations.executionAdapter.id,
    mcpExecutionAdapterConfigured: config.integrations.mcp.configured,
    b402EndpointConfigured: config.integrations.b402.configured,
    durablePersistenceConfigured: config.integrations.persistence.configured,
    walletSignatureConfigured: config.integrations.walletSignature.configured,
    onchainAnchoringConfigured: config.integrations.onchainAnchoring.configured,
    testnetExecutionEnabled: config.integrations.executionAdapter.enabled,
    apiKeyPresent: config.integrations.executionAdapter.apiKeyPresent,
    apiSecretPresent: config.integrations.executionAdapter.apiSecretPresent
  });
});

app.get("/api/config", async (_req, res) => {
  res.json(buildRuntimeConfig({ mcp: await probeBinanceMcp() }));
});

app.get("/api/mcp/status", async (_req, res) => {
  res.json(await probeBinanceMcp({ force: true }));
});

app.get(MCP_OAUTH_CLIENT_METADATA_PATH, (req, res) => {
  const origin = getPublicOrigin(req);
  const clientId = buildMcpClientMetadataUrl(origin);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    client_id: clientId,
    client_name: "ODDISEUS",
    client_uri: origin,
    redirect_uris: [buildMcpCallbackUrl(origin)],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  });
});

app.post("/api/mcp-oauth/connect", async (req, res) => {
  try {
    const origin = getPublicOrigin(req);
    if (!origin.startsWith("https://")) {
      res.status(400).json({
        error:
          "Binance MCP OAuth requires a deployed HTTPS origin. Use the Vercel production URL to connect."
      });
      return;
    }
    const redis = requireRedisForMcpOAuth();

    const serverInfo = await discoverBinanceMcpOAuthServer();
    if (!serverInfo.authorizationServerMetadata?.client_id_metadata_document_supported) {
      res.status(502).json({
        error: "Binance MCP authorization server does not advertise Client ID Metadata Document support."
      });
      return;
    }

    const clientInformation = { client_id: buildMcpClientMetadataUrl(origin) };
    const redirectUrl = new URL(buildMcpCallbackUrl(origin));
    const state = crypto.randomBytes(24).toString("hex");
    const resource = new URL(serverInfo.resourceMetadata?.resource || BINANCE_MCP_SERVER_URL);
    const { authorizationUrl, codeVerifier } = await startAuthorization(
      serverInfo.authorizationServerUrl,
      {
        metadata: serverInfo.authorizationServerMetadata,
        clientInformation,
        redirectUrl,
        state,
        resource
      }
    );

    await redis.set(
      mcpOAuthStateKey(state),
      {
        state,
        codeVerifier,
        clientInformation,
        redirectUri: String(redirectUrl),
        authorizationServerUrl: String(serverInfo.authorizationServerUrl),
        resource: String(resource),
        createdAt: new Date().toISOString()
      },
      { ex: MCP_OAUTH_STATE_TTL_SECONDS }
    );

    res.json({
      status: "authorization_required",
      authorizationUrl: String(authorizationUrl),
      expiresInSeconds: MCP_OAUTH_STATE_TTL_SECONDS
    });
  } catch (err) {
    res.status(502).json({ error: sanitizeErrorMessage(err) });
  }
});

app.get(MCP_OAUTH_CALLBACK_PATH, async (req, res) => {
  const origin = getPublicOrigin(req);
  const error = req.query?.error ? String(req.query.error) : "";
  const code = req.query?.code ? String(req.query.code) : "";
  const state = req.query?.state ? String(req.query.state) : "";

  if (error) {
    res.redirect(`${origin}/?mcp=error&reason=${encodeURIComponent(error)}`);
    return;
  }
  if (!code || !state) {
    res.redirect(`${origin}/?mcp=error&reason=missing_code_or_state`);
    return;
  }

  try {
    const redis = requireRedisForMcpOAuth();
    const stateKey = mcpOAuthStateKey(state);
    const stored = await redis.get(stateKey);
    if (!stored?.codeVerifier || !stored?.clientInformation?.client_id || !stored?.redirectUri) {
      res.redirect(`${origin}/?mcp=error&reason=expired_or_unknown_state`);
      return;
    }

    const serverInfo = await discoverBinanceMcpOAuthServer();
    const tokens = await exchangeAuthorization(stored.authorizationServerUrl, {
      metadata: serverInfo.authorizationServerMetadata,
      clientInformation: stored.clientInformation,
      authorizationCode: code,
      codeVerifier: stored.codeVerifier,
      redirectUri: new URL(stored.redirectUri),
      resource: new URL(stored.resource || serverInfo.resourceMetadata?.resource || BINANCE_MCP_SERVER_URL)
    });

    await saveMcpOAuthTokens(tokens, {
      clientInformation: stored.clientInformation,
      authorizationServerUrl: stored.authorizationServerUrl,
      resource: stored.resource,
      connectedAt: new Date().toISOString()
    });
    await redis.del(stateKey);
    mcpProbeCache = null;

    res.redirect(`${origin}/?mcp=connected`);
  } catch (err) {
    res.redirect(`${origin}/?mcp=error&reason=${encodeURIComponent(sanitizeErrorMessage(err))}`);
  }
});

app.post("/api/mcp-oauth/disconnect", async (_req, res) => {
  const redis = getRedisClient();
  if (redis) await redis.del(MCP_OAUTH_TOKEN_KEY);
  mcpProbeCache = null;
  res.json({
    status: "disconnected",
    mcp: await probeBinanceMcp({ force: true })
  });
});

app.post("/api/runs", async (req, res) => {
  if (req.body?.action) {
    await handleRunAction(req, res);
    return;
  }

  const id = `run_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const intent = {
    text: String(req.body?.intent || "Evaluate a BTCUSDT testnet micro-action."),
    symbol: String(req.body?.symbol || DEFAULT_SYMBOL).toUpperCase(),
    quoteBudgetUsdt: Number(req.body?.quoteBudgetUsdt || policy.maxRunBudgetUsdt),
    mode: "binance-spot-testnet"
  };

  const run = {
    id,
    stage: "intent",
    status: "running",
    completedStages: [],
    intent,
    intentHash: hash(intent),
    policyDecisions: [],
    paidData: [],
    events: [
      {
        id: eventId(),
        at: new Date().toISOString(),
        type: "RUN_CREATED",
        payloadHash: hash(intent)
      }
    ]
  };

  await saveRun(run);
  res.json({ run });
});

async function handleRunAction(req, res) {
  const run = await findRunForAction(req, res);
  if (!run) return;

  try {
    if (req.body.action === "step") {
      if (run.status !== "complete" && run.status !== "blocked") {
        await advance(run);
      }
      await saveRun(run);
      res.json({ run });
      return;
    }

    if (req.body.action === "approve") {
      await approveRun(run, req.body);
      await saveRun(run);
      res.json({ run });
      return;
    }

    if (req.body.action === "prepare_approval") {
      prepareApproval(run, req.body);
      await saveRun(run);
      res.json({ run, approvalMessage: run.pendingApproval.message });
      return;
    }

    if (req.body.action === "reject") {
      rejectRun(run, req.body?.reason);
      await saveRun(run);
      res.json({ run });
      return;
    }

    if (req.body.action === "stop") {
      blockRun(run, run.stage, "Run stopped by human operator before execution finality.");
      await saveRun(run);
      res.json({ run });
      return;
    }

    res.status(400).json({ error: `Unknown run action: ${req.body.action}` });
  } catch (err) {
    blockRun(run, run.stage, err.message);
    await saveRun(run);
    res.status(422).json({ run, error: err.message });
  }
}

async function findRunForAction(req, res) {
  const id = req.body?.id || req.body?.run?.id;
  const existing = id ? await loadRun(id) : null;
  if (existing) return existing;

  if (req.body?.run?.id && req.body.run.intent && Array.isArray(req.body.run.completedStages)) {
    const restored = req.body.run;
    runs.set(restored.id, restored);
    restored.events ||= [];
    restored.policyDecisions ||= [];
    restored.paidData ||= [];
    restored.events.push(event("RUN_RESTORED_FROM_CLIENT_STATE", {
      runId: restored.id,
      stage: restored.stage,
      status: restored.status
    }));
    await saveRun(restored);
    return restored;
  }

  res.status(404).json({
    error:
      "Run not found in durable storage or local cache. If persistence is not configured, the client must send the current run state with each action."
  });
  return null;
}

app.get("/api/runs/:id", async (req, res) => {
  const run = await findRun(req.params.id, res);
  if (!run) return;
  res.json({ run });
});

app.post("/api/runs/:id/approve", async (req, res) => {
  const run = await findRun(req.params.id, res);
  if (!run) return;

  try {
    await approveRun(run, req.body);
    await saveRun(run);
    res.json({ run });
  } catch (err) {
    blockRun(run, run.stage, err.message);
    await saveRun(run);
    res.status(422).json({ run, error: err.message });
  }
});

app.post("/api/runs/:id/prepare-approval", async (req, res) => {
  const run = await findRun(req.params.id, res);
  if (!run) return;

  try {
    prepareApproval(run, req.body);
    await saveRun(run);
    res.json({ run, approvalMessage: run.pendingApproval.message });
  } catch (err) {
    blockRun(run, run.stage, err.message);
    await saveRun(run);
    res.status(422).json({ run, error: err.message });
  }
});

app.post("/api/runs/:id/reject", async (req, res) => {
  const run = await findRun(req.params.id, res);
  if (!run) return;

  rejectRun(run, req.body?.reason);
  await saveRun(run);
  res.json({ run });
});

function prepareApproval(run, requestBody = {}) {
  if (run.stage !== "approval" || run.status !== "needs_approval") {
    throw new Error("Approval challenge can only be prepared at the approval stage.");
  }

  const issuedAt = new Date().toISOString();
  const challenge = {
    service: "ODDISEUS",
    version: PRODUCT_VERSION,
    purpose: "Authorize a real Binance Spot Testnet order",
    runId: run.id,
    action: "MARKET_BUY",
    symbol: run.intent.symbol,
    quoteBudgetUsdt: run.intent.quoteBudgetUsdt,
    intentHash: run.intentHash,
    marketSnapshotHash: run.marketSnapshot?.snapshotHash,
    riskAssessmentHash: run.riskAssessment?.assessmentHash,
    policyDecisionsHash: hash(run.policyDecisions),
    executionAdapter: "binance-spot-testnet-rest",
    policyRef: policy.humanApprovalRef,
    chainScope: "evm",
    requestedSigner: requestBody.address || requestBody.signerAddress || null,
    requestedChainId: requestBody.chainId || null,
    nonce: crypto.randomBytes(16).toString("hex"),
    issuedAt
  };
  const message = formatApprovalMessage(challenge);

  run.pendingApproval = {
    challenge,
    message,
    messageHash: hash(message)
  };
  run.events.push(event("WALLET_APPROVAL_CHALLENGE_CREATED", run.pendingApproval));
}

async function approveRun(run, requestBody = {}) {
  if (run.stage !== "approval") {
    throw new Error("Run is not waiting for approval.");
  }

  const pending = run.pendingApproval;
  if (!pending?.message) {
    throw new Error("Missing wallet approval challenge. Prepare approval before signing.");
  }

  const signerAddress = String(requestBody.address || requestBody.signerAddress || "").trim();
  const signature = String(requestBody.signature || "").trim();
  const message = String(requestBody.message || "");

  if (!signerAddress || !signature || !message) {
    throw new Error("Wallet address, signature, and signed message are required for approval.");
  }
  if (message !== pending.message) {
    throw new Error("Signed message does not match the active ODDISEUS approval challenge.");
  }

  const verified = await verifyMessage({
    address: signerAddress,
    message,
    signature
  });

  if (!verified) {
    throw new Error("Wallet signature verification failed.");
  }

  run.approval = {
    approved: true,
    approvedAt: new Date().toISOString(),
    approver: "wallet-operator",
    signerAddress,
    chainId: requestBody.chainId || pending.challenge.requestedChainId || null,
    connector: requestBody.connector || null,
    signature,
    signatureHash: hash(signature),
    approvalMessageHash: pending.messageHash,
    approvalHash: hash({
      runId: run.id,
      stage: run.stage,
      signerAddress,
      signature,
      messageHash: pending.messageHash
    })
  };
  delete run.pendingApproval;
  run.events.push(event("WALLET_APPROVAL_VERIFIED", {
    ...run.approval,
    signature: "[redacted-in-event-hash]"
  }));

  completeStage(run, "approval");
  run.stage = "execution";
  run.status = "running";
}

function rejectRun(run, reason) {
  run.approval = {
    approved: false,
    rejectedAt: new Date().toISOString(),
    approver: "human-operator",
    reason: String(reason || "Human operator rejected sovereign clearance."),
    approvalHash: hash({ runId: run.id, stage: run.stage, rejected: true, at: Date.now() })
  };
  blockRun(run, run.stage, run.approval.reason);
}

app.post("/api/runs/:id/stop", async (req, res) => {
  const run = await findRun(req.params.id, res);
  if (!run) return;

  blockRun(run, run.stage, "Run stopped by human operator before execution finality.");
  await saveRun(run);
  res.json({ run });
});

app.post("/api/runs/:id/step", async (req, res) => {
  const run = await findRun(req.params.id, res);
  if (!run) return;

  if (run.status === "complete" || run.status === "blocked") {
    res.json({ run });
    return;
  }

  try {
    await advance(run);
    await saveRun(run);
    res.json({ run });
  } catch (err) {
    blockRun(run, run.stage, err.message);
    await saveRun(run);
    res.status(422).json({ run, error: err.message });
  }
});

app.get("/api/runs/:id/receipt", async (req, res) => {
  const run = await findRun(req.params.id, res);
  if (!run) return;
  if (!run.receipt) {
    res.status(404).json({ error: "Receipt is not ready yet." });
    return;
  }
  res.json(run.receipt);
});

app.use(express.static(path.join(projectRoot, "dist")));
app.get("*splat", (req, res) => {
  res.sendFile(path.join(projectRoot, "dist", "index.html"));
});

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`ODDISEUS listening on http://127.0.0.1:${PORT}`);
  });
}

export default app;

async function advance(run) {
  if (run.stage === "intent") {
    checkIntent(run);
    completeStage(run, "intent");
    run.stage = "market";
    return;
  }

  if (run.stage === "market") {
    run.marketSnapshot = await getMarketSnapshot(run.intent.symbol);
    run.events.push(event("MARKET_SNAPSHOT", run.marketSnapshot));
    completeStage(run, "market");
    run.stage = "paid-data";
    return;
  }

  if (run.stage === "paid-data") {
    const paidData = await requestPaidData(run);
    run.paidData.push(paidData);
    run.events.push(event("EXTERNAL_INTEL_CHECKED", paidData));
    completeStage(run, "paid-data");
    run.stage = "risk";
    return;
  }

  if (run.stage === "risk") {
    run.riskAssessment = assessRisk(run);
    run.events.push(event("RISK_ASSESSMENT", run.riskAssessment));
    completeStage(run, "risk");
    run.stage = "policy";
    return;
  }

  if (run.stage === "policy") {
    run.policyDecisions.push(...evaluatePolicy(run));
    run.events.push(event("POLICY_EVALUATED", run.policyDecisions));
    const denied = run.policyDecisions.find((item) => item.decision === "DENY");
    if (denied) {
      blockRun(run, "policy", denied.reason);
      return;
    }
    completeStage(run, "policy");
    run.stage = policy.realExecutionRequiresApproval ? "approval" : "execution";
    run.status = policy.realExecutionRequiresApproval ? "needs_approval" : "running";
    return;
  }

  if (run.stage === "approval") {
    run.status = "needs_approval";
    return;
  }

  if (run.stage === "execution") {
    run.execution = await executeTestnetOrder(run);
    run.events.push(event("TESTNET_EXECUTION", run.execution));
    completeStage(run, "execution");
    run.stage = "receipt";
    return;
  }

  if (run.stage === "receipt") {
    run.receipt = buildReceipt(run);
    run.reputation = buildReputation(run);
    run.events.push(event("RECEIPT_CREATED", run.receipt));
    completeStage(run, "receipt");
    run.status = "complete";
  }
}

function checkIntent(run) {
  if (!policy.allowedSymbols.includes(run.intent.symbol)) {
    throw new Error(`Symbol ${run.intent.symbol} is not allowed by policy.`);
  }
  if (run.intent.quoteBudgetUsdt > policy.maxRunBudgetUsdt) {
    throw new Error(`Budget exceeds ${policy.maxRunBudgetUsdt} USDT policy cap.`);
  }
}

async function getMarketSnapshot(symbol) {
  const [spot, futuresBook, markPrice, openInterest, longShort, adl] = await Promise.all([
    fetchJson(`${TESTNET_BASE_URL}/api/v3/ticker/bookTicker?symbol=${symbol}`),
    fetchJson(`${FUTURES_TESTNET_BASE_URL}/fapi/v1/ticker/bookTicker?symbol=${symbol}`),
    fetchJson(`${FUTURES_TESTNET_BASE_URL}/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchJson(`${FUTURES_TESTNET_BASE_URL}/fapi/v1/openInterest?symbol=${symbol}`),
    fetchJson(
      `${FUTURES_TESTNET_BASE_URL}/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=5m&limit=3`
    ).catch(() => []),
    fetchJson(`${FUTURES_TESTNET_BASE_URL}/fapi/v1/adlQuantile?symbol=${symbol}`).catch(() => [])
  ]);

  const bid = Number(spot.bidPrice);
  const ask = Number(spot.askPrice);
  const mid = (bid + ask) / 2;
  const spreadBps = mid > 0 ? Number((((ask - bid) / mid) * 10000).toFixed(4)) : null;

  return {
    source: "Binance Spot/Futures Testnet",
    capturedAt: new Date().toISOString(),
    spot,
    futures: {
      book: futuresBook,
      markPrice: markPrice.markPrice,
      indexPrice: markPrice.indexPrice,
      lastFundingRate: markPrice.lastFundingRate,
      nextFundingTime: markPrice.nextFundingTime,
      openInterest: openInterest.openInterest,
      topTraderLongShort: longShort,
      adlRisk: normalizeAdlRisk(adl)
    },
    derived: {
      spreadBps
    },
    snapshotHash: hash({ spot, futuresBook, markPrice, openInterest, longShort, adl })
  };
}

async function requestPaidData(run) {
  const merchant = process.env.B402_TESTNET_ENDPOINT;
  if (!merchant) {
    return {
      id: eventId(),
      status: "not_configured",
      merchant: "B402/x402 testnet endpoint",
      priceUsdt: 0,
      summary:
        "No real B402/x402 testnet endpoint is configured. ODDISEUS records the dependency gap and does not fabricate paid intelligence.",
      payloadHash: hash({ runId: run.id, missing: "B402_TESTNET_ENDPOINT" })
    };
  }

  const response = await fetch(merchant, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: run.id,
      symbol: run.intent.symbol,
      marketSnapshotHash: run.marketSnapshot.snapshotHash
    })
  });
  const payload = await response.json();
  return {
    id: eventId(),
    status: response.ok ? "acquired" : "challenge_or_blocked",
    merchant,
    priceUsdt: Number(payload.priceUsdt || 0),
    summary: payload.summary || "Paid intelligence response captured.",
    payloadHash: hash(payload)
  };
}

function assessRisk(run) {
  const fundingRate = Number(run.marketSnapshot?.futures?.lastFundingRate || 0);
  const spreadBps = Number(run.marketSnapshot?.derived?.spreadBps || 0);
  const adlRisk = run.marketSnapshot?.futures?.adlRisk || "UNKNOWN";

  const flags = [];
  if (Math.abs(fundingRate) > policy.maxFundingRateAbs) flags.push("funding_above_policy");
  if (spreadBps > policy.maxSpreadBps) flags.push("spread_above_policy");
  if (policy.denyIfAdlRisk.includes(adlRisk)) flags.push("adl_risk_denied");

  return {
    agentId: "risk-agent",
    status: flags.length ? "caution" : "clear",
    flags,
    fundingRate,
    spreadBps,
    adlRisk,
    assessmentHash: hash({ fundingRate, spreadBps, adlRisk, flags })
  };
}

function evaluatePolicy(run) {
  const decisions = [];
  const paidData = run.paidData[0];
  const risk = run.riskAssessment;

  decisions.push(decision("ALLOW", "READ_MARKET", "Market data read is allowed for the requested symbol."));

  if (paidData?.priceUsdt > policy.maxPaidDataUsdt) {
    decisions.push(
      decision("DENY", "EXTERNAL_INTEL", `External intelligence price exceeds ${policy.maxPaidDataUsdt} USDT cap.`)
    );
  } else if (paidData?.status === "not_configured" || paidData?.status === "blocked_external_not_configured") {
    decisions.push(
      decision(
        "SKIP",
        "EXTERNAL_INTEL",
        "B402/x402 testnet endpoint is not configured; no external intelligence is claimed or fabricated."
      )
    );
  } else {
    decisions.push(decision("ALLOW", "EXTERNAL_INTEL", "External intelligence spend is inside policy cap."));
  }

  if (risk?.flags?.length) {
    decisions.push(decision("DENY", "TESTNET_SPOT", `Risk flags: ${risk.flags.join(", ")}.`));
  } else {
    decisions.push(
      decision("ESCALATE", "TESTNET_SPOT", "Testnet execution requires human approval.")
    );
  }

  return decisions;
}

async function executeTestnetOrder(run) {
  const apiKey = process.env.BINANCE_TESTNET_API_KEY;
  const apiSecret = process.env.BINANCE_TESTNET_API_SECRET;
  const enabled = process.env.ODDISEUS_ENABLE_TESTNET_EXECUTION === "true";

  if (!apiKey || !apiSecret) {
    return blockedExecution("Missing Binance Spot Testnet API key/secret.");
  }
  if (!enabled) {
    return blockedExecution("Set ODDISEUS_ENABLE_TESTNET_EXECUTION=true to permit real testnet execution.");
  }
  if (!run.approval?.approved) {
    return blockedExecution("Human approval is required before testnet execution.");
  }

  const payload = {
    symbol: run.intent.symbol,
    side: "BUY",
    type: "MARKET",
    quoteOrderQty: String(run.intent.quoteBudgetUsdt),
    timestamp: Date.now(),
    recvWindow: 5000,
    newClientOrderId: `oddiseus_${run.id}`.slice(0, 32)
  };

  const result = await signedRequest("/api/v3/order", payload, apiKey, apiSecret);
  return {
    status: "testnet_executed",
    adapter: "Binance Spot Testnet REST execution adapter",
    action: "MARKET_BUY",
    symbol: run.intent.symbol,
    quoteBudgetUsdt: run.intent.quoteBudgetUsdt,
    orderId: result.orderId,
    clientOrderId: result.clientOrderId,
    transactTime: result.transactTime,
    proofHash: hash(result),
    rawHash: hash({ result })
  };
}

function blockedExecution(reason) {
  return {
    status: "blocked",
    adapter: "Binance Spot Testnet",
    action: "MARKET_BUY",
    blockedReason: reason,
    proofHash: hash({ blocked: true, reason })
  };
}

function buildReceipt(run) {
  const receipt = {
    receiptVersion: "oddiseus-v0.1",
    runId: run.id,
    createdAt: new Date().toISOString(),
    intent: run.intent,
    intentHash: run.intentHash,
    marketSnapshotHash: run.marketSnapshot?.snapshotHash,
    paidData: run.paidData,
    riskAssessment: run.riskAssessment,
    policyDecisions: run.policyDecisions,
    approval: run.approval || null,
    execution: run.execution,
    eventHashes: run.events.map((item) => item.eventHash),
    outcome: run.execution?.status === "testnet_executed" ? "TESTNET_EXECUTED" : "BLOCKED_WITH_PROOF"
  };
  return {
    ...receipt,
    receiptHash: hash(receipt)
  };
}

function buildReputation(run) {
  const outcome = run.receipt?.outcome || "PENDING";
  return [
    {
      agentId: "research-agent",
      role: "Market Reader",
      summary: `Collected live Binance testnet market data. External intelligence status: ${
        run.paidData?.[0]?.status || "pending"
      }. Outcome: ${outcome}.`
    },
    {
      agentId: "risk-agent",
      role: "Risk",
      summary: `Evaluated spread, funding, ADL, and policy flags. Status: ${
        run.riskAssessment?.status || "pending"
      }.`
    },
    {
      agentId: "execution-agent",
      role: "Execution",
      summary: `Requested testnet execution through policy. Status: ${
        run.execution?.status || "pending"
      }.`
    }
  ];
}

async function signedRequest(pathname, params, apiKey, apiSecret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
  const url = `${TESTNET_BASE_URL}${pathname}?${query}&signature=${signature}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.msg || `Binance testnet request failed with ${response.status}`);
  }
  return payload;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.msg || `Request failed with ${response.status}: ${url}`);
  }
  return payload;
}

function normalizeAdlRisk(payload) {
  if (!Array.isArray(payload) || payload.length === 0) return "UNKNOWN";
  const symbolRow = payload[0];
  const values = Object.values(symbolRow).filter((value) => typeof value === "number");
  const max = values.length ? Math.max(...values) : 0;
  if (max >= 4) return "HIGH";
  if (max >= 2) return "MEDIUM";
  return "LOW";
}

function normalizeBaseUrl(value, fallback) {
  let url = String(value || fallback).trim();
  if (url.startsWith("//")) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/api$/i, "");
  return url;
}

function normalizeEndpointUrl(value, fallback) {
  let url = String(value || fallback).trim();
  if (url.startsWith("//")) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

function normalizeSecretToken(value) {
  return String(value || "").replace(/\s+/g, "");
}

function sanitizeErrorMessage(err) {
  const message = String(err?.message || "Upstream request failed.");
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/access[_-]?token[=:]\s*[A-Za-z0-9._~+/=-]+/gi, "access_token=[redacted]")
    .replace(/authorization[=:]\s*[A-Za-z0-9._~+/=-]+/gi, "authorization=[redacted]");
}

function secretFingerprint(value) {
  const token = normalizeSecretToken(value);
  if (!token) return null;
  return {
    length: token.length,
    sha256Prefix: crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)
  };
}

function getPublicOrigin(req) {
  const configured =
    process.env.ODDISEUS_PUBLIC_ORIGIN || process.env.PUBLIC_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (configured) return normalizeOrigin(configured);

  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host") || `127.0.0.1:${PORT}`;
  const forwardedProto = req.get("x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  return normalizeOrigin(`${proto}://${host}`);
}

function normalizeOrigin(value) {
  let origin = String(value || "").trim();
  if (!origin) return "";
  if (!/^https?:\/\//i.test(origin)) origin = `https://${origin}`;
  return origin.replace(/\/+$/, "");
}

function buildMcpClientMetadataUrl(origin) {
  return `${origin}${MCP_OAUTH_CLIENT_METADATA_PATH}`;
}

function buildMcpCallbackUrl(origin) {
  return `${origin}${MCP_OAUTH_CALLBACK_PATH}`;
}

function mcpOAuthStateKey(state) {
  return `oddiseus:mcp:binance:oauth:state:${state}`;
}

function requireRedisForMcpOAuth() {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error("Durable Redis storage is required before starting Binance MCP OAuth.");
  }
  return redis;
}

async function discoverBinanceMcpOAuthServer() {
  return discoverOAuthServerInfo(new URL(BINANCE_MCP_SERVER_URL), {
    fetchFn: fetch
  });
}

async function saveMcpOAuthTokens(tokens, metadata = {}) {
  const redis = requireRedisForMcpOAuth();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
    : null;

  await redis.set(MCP_OAUTH_TOKEN_KEY, {
    ...metadata,
    tokens,
    tokenFingerprint: secretFingerprint(tokens.access_token),
    expiresAt,
    updatedAt: new Date().toISOString()
  });
}

async function loadMcpOAuthTokenRecord() {
  const redis = getRedisClient();
  if (!redis) return null;
  return redis.get(MCP_OAUTH_TOKEN_KEY);
}

async function getMcpCredential() {
  const stored = await loadMcpOAuthTokenRecord();
  if (stored?.tokens?.access_token) {
    if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now() + 30_000) {
      if (stored.tokens.refresh_token) {
        const serverInfo = await discoverBinanceMcpOAuthServer();
        const refreshed = await refreshAuthorization(stored.authorizationServerUrl, {
          metadata: serverInfo.authorizationServerMetadata,
          clientInformation: stored.clientInformation,
          refreshToken: stored.tokens.refresh_token,
          resource: new URL(stored.resource || serverInfo.resourceMetadata?.resource || BINANCE_MCP_SERVER_URL)
        });
        await saveMcpOAuthTokens(refreshed, {
          clientInformation: stored.clientInformation,
          authorizationServerUrl: stored.authorizationServerUrl,
          resource: stored.resource,
          connectedAt: stored.connectedAt,
          refreshedAt: new Date().toISOString()
        });
        return {
          token: normalizeSecretToken(refreshed.access_token),
          auth: "oauth_user_token",
          source: "binance_mcp_oauth",
          expiresAt: refreshed.expires_in
            ? new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString()
            : null
        };
      }

      return {
        token: "",
        auth: "oauth_token_expired",
        source: "binance_mcp_oauth",
        expiresAt: stored.expiresAt,
        expired: true
      };
    }

    return {
      token: normalizeSecretToken(stored.tokens.access_token),
      auth: "oauth_user_token",
      source: "binance_mcp_oauth",
      expiresAt: stored.expiresAt || null,
      connectedAt: stored.connectedAt || null
    };
  }

  if (BINANCE_MCP_ACCESS_TOKEN) {
    return {
      token: BINANCE_MCP_ACCESS_TOKEN,
      auth: "legacy_env_bearer_token",
      source: "vercel_env",
      expiresAt: null
    };
  }

  return null;
}

function getCachedOrStaticMcpStatus() {
  if (mcpProbeCache?.status && Date.now() - mcpProbeCache.checkedAtMs < 60_000) {
    return mcpProbeCache.status;
  }
  return buildStaticMcpStatus();
}

function buildStaticMcpStatus() {
  return {
    id: "binance-agent-os-mcp",
    label: "Binance Agent OS MCP transport",
    configured: Boolean(BINANCE_MCP_ACCESS_TOKEN),
    enabled: Boolean(BINANCE_MCP_ACCESS_TOKEN),
    status: BINANCE_MCP_ACCESS_TOKEN ? "pending_validation" : "blocked_auth_required",
    serverUrl: BINANCE_MCP_SERVER_URL,
    protocol: "streamable_http",
    auth: BINANCE_MCP_ACCESS_TOKEN ? "bearer_token_configured" : "oauth_token_required",
    authTokenFingerprint: secretFingerprint(BINANCE_MCP_ACCESS_TOKEN),
    reason: BINANCE_MCP_ACCESS_TOKEN
      ? "MCP token is configured but the live handshake has not been validated in this runtime cache yet."
      : "Missing BINANCE_MCP_ACCESS_TOKEN. Binance Agent OS MCP returned 401 without authorization.",
    docsUrl: "https://developers.binance.com/en/docs/agent-native/mcp-server/agentic"
  };
}

async function probeBinanceMcp({ force = false } = {}) {
  if (!force && mcpProbeCache?.status && Date.now() - mcpProbeCache.checkedAtMs < 60_000) {
    return mcpProbeCache.status;
  }

  const credential = await getMcpCredential();
  if (!credential?.token) {
    const status = buildStaticMcpStatus();
    if (credential?.expired) {
      status.configured = true;
      status.auth = credential.auth;
      status.status = "blocked_auth_required";
      status.reason = "The Binance MCP OAuth token expired and no refresh token is available. Reconnect Binance MCP.";
      status.expiresAt = credential.expiresAt;
    }
    mcpProbeCache = { checkedAtMs: Date.now(), status };
    return status;
  }

  const client = new Client({
    name: "oddiseus-clearing-layer",
    version: PRODUCT_VERSION
  });
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 8_000);

  try {
    const transport = new StreamableHTTPClientTransport(new URL(BINANCE_MCP_SERVER_URL), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${credential.token}`
        },
        signal: abortController.signal
      }
    });

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = (tools.tools || []).map((tool) => tool.name).filter(Boolean);
    const status = {
      id: "binance-agent-os-mcp",
      label: "Binance Agent OS MCP transport",
      configured: true,
      enabled: true,
      status: "live",
      serverUrl: BINANCE_MCP_SERVER_URL,
      protocol: "streamable_http",
      auth: credential.auth,
      authSource: credential.source,
      authTokenFingerprint: secretFingerprint(credential.token),
      tokenExpiresAt: credential.expiresAt,
      connectedAt: credential.connectedAt || null,
      toolCount: toolNames.length,
      sampledTools: toolNames.slice(0, 8),
      checkedAt: new Date().toISOString(),
      probeHash: hash({
        serverUrl: BINANCE_MCP_SERVER_URL,
        toolNames
      }),
      docsUrl: "https://developers.binance.com/en/docs/agent-native/mcp-server/agentic"
    };
    mcpProbeCache = { checkedAtMs: Date.now(), status };
    return status;
  } catch (err) {
    const statusCode = err?.code || err?.status || null;
    const authBlocked = statusCode === 401 || statusCode === 403;
    const safeReason = sanitizeErrorMessage(err);
    const status = {
      id: "binance-agent-os-mcp",
      label: "Binance Agent OS MCP transport",
      configured: true,
      enabled: false,
      status: authBlocked ? "blocked_auth_required" : "blocked",
      serverUrl: BINANCE_MCP_SERVER_URL,
      protocol: "streamable_http",
      auth: credential.auth,
      authSource: credential.source,
      authTokenFingerprint: secretFingerprint(credential.token),
      tokenExpiresAt: credential.expiresAt,
      checkedAt: new Date().toISOString(),
      statusCode,
      reason: authBlocked
        ? "Binance MCP rejected the configured token or requires additional OAuth authorization."
        : safeReason,
      docsUrl: "https://developers.binance.com/en/docs/agent-native/mcp-server/agentic"
    };
    mcpProbeCache = { checkedAtMs: Date.now(), status };
    return status;
  } finally {
    clearTimeout(timeout);
    try {
      await client.close();
    } catch {
      // No-op: failed handshakes may not create a closable MCP session.
    }
  }
}

function formatApprovalMessage(challenge) {
  return [
    "ODDISEUS Wallet Approval",
    "",
    `Purpose: ${challenge.purpose}`,
    `Run ID: ${challenge.runId}`,
    `Action: ${challenge.action}`,
    `Symbol: ${challenge.symbol}`,
    `Quote Budget USDT: ${challenge.quoteBudgetUsdt}`,
    `Execution Adapter: ${challenge.executionAdapter}`,
    `Policy Ref: ${challenge.policyRef}`,
    "",
    `Intent Hash: ${challenge.intentHash}`,
    `Market Snapshot Hash: ${challenge.marketSnapshotHash || "pending"}`,
    `Risk Assessment Hash: ${challenge.riskAssessmentHash || "pending"}`,
    `Policy Decisions Hash: ${challenge.policyDecisionsHash}`,
    "",
    `Requested Signer: ${challenge.requestedSigner || "any-evm-signer"}`,
    `Requested Chain ID: ${challenge.requestedChainId || "wallet-current-chain"}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
    "",
    "Signing this message authorizes ODDISEUS to place the described Binance Spot Testnet order only. It does not authorize mainnet trading, withdrawals, leverage, custody, or transfer of real funds."
  ].join("\n");
}

function buildRuntimeConfig({ mcp } = {}) {
  const apiKeyPresent = Boolean(process.env.BINANCE_TESTNET_API_KEY);
  const apiSecretPresent = Boolean(process.env.BINANCE_TESTNET_API_SECRET);
  const testnetExecutionEnabled = process.env.ODDISEUS_ENABLE_TESTNET_EXECUTION === "true";
  const b402Configured = Boolean(process.env.B402_TESTNET_ENDPOINT);
  const persistenceConfigured = isDurablePersistenceConfigured();
  const walletSignatureConfigured = true;
  const walletConnectConfigured = Boolean(process.env.VITE_WALLETCONNECT_PROJECT_ID);
  const onchainAnchoringConfigured = Boolean(process.env.ODDISEUS_ONCHAIN_ANCHOR_ENDPOINT);

  return {
    service: "oddiseus",
    version: PRODUCT_VERSION,
    truthMode: TRUTH_MODE,
    runtime: {
      environment: process.env.VERCEL ? "vercel" : "local",
      vercelRegion: process.env.VERCEL_REGION || null,
      stateMode: persistenceConfigured ? "durable" : "client_restored_serverless_state"
    },
    defaults: {
      symbol: DEFAULT_SYMBOL,
      quoteBudgetUsdt: policy.maxRunBudgetUsdt,
      intentText:
        "Clear a BTCUSDT testnet micro-action through live Binance Testnet data, deterministic risk policy, human approval, real testnet execution, and a verifiable receipt. External paid-intelligence is used only when a real B402/x402 testnet endpoint is configured."
    },
    network: {
      label: "Binance Testnet",
      executionNetwork: "Binance Spot Testnet",
      executionMode: "real_testnet_only",
      mainnetEnabled: false,
      withdrawalsEnabled: false,
      leverageEnabled: false
    },
    policy,
    integrations: {
      binanceSpot: {
        id: "binance-spot-testnet-market-data",
        label: "Binance Spot Testnet market data",
        configured: true,
        enabled: true,
        status: "live",
        baseUrl: TESTNET_BASE_URL
      },
      binanceFutures: {
        id: "binance-futures-testnet-market-data",
        label: "Binance Futures Testnet market data",
        configured: true,
        enabled: true,
        status: "live",
        baseUrl: FUTURES_TESTNET_BASE_URL
      },
      executionAdapter: {
        id: "binance-spot-testnet-rest",
        label: "Binance Spot Testnet REST execution adapter",
        configured: apiKeyPresent && apiSecretPresent,
        enabled: apiKeyPresent && apiSecretPresent && testnetExecutionEnabled,
        status: apiKeyPresent && apiSecretPresent && testnetExecutionEnabled ? "live" : "blocked",
        apiKeyPresent,
        apiSecretPresent,
        approvalRequired: policy.realExecutionRequiresApproval
      },
      b402: {
        id: "b402-x402-testnet-endpoint",
        label: "B402/x402 external intelligence endpoint",
        configured: b402Configured,
        enabled: b402Configured,
        status: b402Configured ? "live" : "not_configured"
      },
      mcp: mcp || getCachedOrStaticMcpStatus(),
      walletSignature: {
        id: "wallet-operator-signature",
        label: "Wallet approval signature",
        configured: walletSignatureConfigured,
        enabled: walletSignatureConfigured,
        status: "live",
        supportedMethods: ["eip191_personal_sign"],
        supportedWallets: walletConnectConfigured
          ? ["injected-evm-wallets", "walletconnect"]
          : ["injected-evm-wallets"],
        walletConnectConfigured
      },
      onchainAnchoring: {
        id: "receipt-onchain-anchor",
        label: "Receipt on-chain anchoring",
        configured: onchainAnchoringConfigured,
        enabled: onchainAnchoringConfigured,
        status: onchainAnchoringConfigured ? "live" : "not_configured"
      },
      persistence: {
        id: "durable-run-receipt-store",
        label: "Durable run and receipt storage",
        configured: persistenceConfigured,
        enabled: persistenceConfigured,
        status: persistenceConfigured ? "live" : "not_configured",
        adapter:
          process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
            ? "upstash-redis-rest"
            : null
      }
    }
  };
}

function decision(decisionValue, action, reason) {
  return {
    id: eventId(),
    at: new Date().toISOString(),
    decision: decisionValue,
    action,
    reason,
    decisionHash: hash({ decisionValue, action, reason })
  };
}

function completeStage(run, stage) {
  if (!run.completedStages.includes(stage)) {
    run.completedStages.push(stage);
  }
}

function blockRun(run, stage, reason) {
  run.status = "blocked";
  run.blockedStage = stage;
  run.events.push(event("RUN_BLOCKED", { stage, reason }));
}

async function findRun(id, res) {
  const run = await loadRun(id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return null;
  }
  return run;
}

async function loadRun(id) {
  const cached = runs.get(id);
  if (cached) return cached;

  const redis = getRedisClient();
  if (!redis) return null;

  const persisted = await redis.get(runKey(id));
  if (!persisted) return null;
  runs.set(id, persisted);
  return persisted;
}

async function saveRun(run) {
  runs.set(run.id, run);

  const redis = getRedisClient();
  if (!redis) return;

  await redis.set(runKey(run.id), run);
  await redis.zadd("oddiseus:runs", { score: Date.now(), member: run.id });
  if (run.receipt) {
    await redis.set(receiptKey(run.id), run.receipt);
  }
}

function getRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  if (!redisClient) {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

function isDurablePersistenceConfigured() {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  );
}

function runKey(id) {
  return `oddiseus:run:${id}`;
}

function receiptKey(id) {
  return `oddiseus:receipt:${id}`;
}

function event(type, payload) {
  const item = {
    id: eventId(),
    at: new Date().toISOString(),
    type,
    payloadHash: hash(payload)
  };
  item.eventHash = hash(item);
  return item;
}

function eventId() {
  return `evt_${crypto.randomBytes(6).toString("hex")}`;
}

function hash(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
