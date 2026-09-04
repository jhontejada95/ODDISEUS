import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const app = express();
const runs = new Map();

app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 5173);
const DEFAULT_SYMBOL = process.env.ODDISEUS_DEFAULT_SYMBOL || "BTCUSDT";
const TESTNET_BASE_URL =
  process.env.BINANCE_TESTNET_BASE_URL || "https://testnet.binance.vision";
const FUTURES_TESTNET_BASE_URL =
  process.env.BINANCE_FUTURES_TESTNET_BASE_URL || "https://demo-fapi.binance.com";

const policy = {
  maxRunBudgetUsdt: 10,
  maxPaidDataUsdt: 0.25,
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  allowedActions: ["READ_MARKET", "BUY_DATA", "TESTNET_SPOT"],
  realExecutionRequiresApproval: true,
  maxSpreadBps: 12,
  maxFundingRateAbs: 0.0005,
  denyIfAdlRisk: ["HIGH"],
  denyWithdrawals: true,
  denyLeverage: true
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

app.post("/api/runs", (req, res) => {
  if (req.body?.action) {
    handleRunAction(req, res);
    return;
  }

  const id = `run_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const intent = {
    text: String(req.body?.intent || "Evaluate a BTCUSDT testnet micro-action."),
    symbol: String(req.body?.symbol || DEFAULT_SYMBOL).toUpperCase(),
    quoteBudgetUsdt: Number(req.body?.quoteBudgetUsdt || 10),
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

  runs.set(id, run);
  res.json({ run });
});

async function handleRunAction(req, res) {
  const run = findRunForAction(req, res);
  if (!run) return;

  try {
    if (req.body.action === "step") {
      if (run.status !== "complete" && run.status !== "blocked") {
        await advance(run);
      }
      res.json({ run });
      return;
    }

    if (req.body.action === "approve") {
      approveRun(run);
      res.json({ run });
      return;
    }

    if (req.body.action === "reject") {
      rejectRun(run, req.body?.reason);
      res.json({ run });
      return;
    }

    if (req.body.action === "stop") {
      blockRun(run, run.stage, "Run stopped by human operator before execution finality.");
      res.json({ run });
      return;
    }

    res.status(400).json({ error: `Unknown run action: ${req.body.action}` });
  } catch (err) {
    blockRun(run, run.stage, err.message);
    res.status(422).json({ run, error: err.message });
  }
}

function findRunForAction(req, res) {
  const id = req.body?.id || req.body?.run?.id;
  const existing = id ? runs.get(id) : null;
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
    return restored;
  }

  res.status(404).json({
    error:
      "Run not found. In serverless deployments the client must send the current run state with each action."
  });
  return null;
}

app.get("/api/runs/:id", (req, res) => {
  const run = findRun(req.params.id, res);
  if (!run) return;
  res.json({ run });
});

app.post("/api/runs/:id/approve", (req, res) => {
  const run = findRun(req.params.id, res);
  if (!run) return;

  approveRun(run);
  res.json({ run });
});

app.post("/api/runs/:id/reject", (req, res) => {
  const run = findRun(req.params.id, res);
  if (!run) return;

  rejectRun(run, req.body?.reason);
  res.json({ run });
});

function approveRun(run) {
  run.approval = {
    approved: true,
    approvedAt: new Date().toISOString(),
    approver: "human-operator",
    approvalHash: hash({ runId: run.id, stage: run.stage, at: Date.now() })
  };
  run.events.push(event("HUMAN_APPROVAL", run.approval));

  if (run.stage === "approval") {
    completeStage(run, "approval");
    run.stage = "execution";
    run.status = "running";
  }
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

app.post("/api/runs/:id/stop", (req, res) => {
  const run = findRun(req.params.id, res);
  if (!run) return;

  blockRun(run, run.stage, "Run stopped by human operator before execution finality.");
  res.json({ run });
});

app.post("/api/runs/:id/step", async (req, res) => {
  const run = findRun(req.params.id, res);
  if (!run) return;

  if (run.status === "complete" || run.status === "blocked") {
    res.json({ run });
    return;
  }

  try {
    await advance(run);
    res.json({ run });
  } catch (err) {
    blockRun(run, run.stage, err.message);
    res.status(422).json({ run, error: err.message });
  }
});

app.get("/api/runs/:id/receipt", (req, res) => {
  const run = findRun(req.params.id, res);
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
    run.events.push(event("PAID_DATA_ACQUIRED", paidData));
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
      status: "blocked_external_not_configured",
      merchant: "B402/x402 testnet endpoint",
      priceUsdt: 0,
      summary:
        "External paid-intelligence endpoint is not configured yet. ODDISEUS records the missing dependency instead of pretending a payment happened.",
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
      decision("DENY", "BUY_DATA", `Paid data price exceeds ${policy.maxPaidDataUsdt} USDT cap.`)
    );
  } else if (paidData?.status === "blocked_external_not_configured") {
    decisions.push(
      decision(
        "ESCALATE",
        "BUY_DATA",
        "B402/x402 testnet endpoint is not configured; receipt records the dependency gap."
      )
    );
  } else {
    decisions.push(decision("ALLOW", "BUY_DATA", "Paid data spend is inside policy cap."));
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
    adapter: "Binance Spot Testnet REST/MCP-compatible execution adapter",
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
      role: "Research",
      summary: `Collected Binance testnet market data and requested paid intelligence. Outcome: ${outcome}.`
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

function findRun(id, res) {
  const run = runs.get(id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return null;
  }
  return run;
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
