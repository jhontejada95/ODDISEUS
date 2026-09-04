import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  CircleDollarSign,
  Download,
  Eye,
  Fingerprint,
  Gauge,
  KeyRound,
  LockKeyhole,
  Network,
  Play,
  RefreshCcw,
  ShieldCheck,
  SquareTerminal,
  X
} from "lucide-react";
import "./styles.css";

const STAGES = [
  "intent",
  "market",
  "paid-data",
  "risk",
  "policy",
  "approval",
  "execution",
  "receipt"
];

const stageMeta = {
  intent: ["Intent", "Verified"],
  market: ["Market Data", "Ingested"],
  "paid-data": ["Paid Intel", "Settled"],
  risk: ["Risk Check", "Scored"],
  policy: ["Policy Check", "Evaluated"],
  approval: ["Human Approval", "Gate Active"],
  execution: ["Execution", "Pending"],
  receipt: ["Receipt", "Standby"]
};

const navItems = [
  ["console", "Console"],
  ["policy", "Policy Matrix"],
  ["receipts", "Receipts"],
  ["agents", "Agent Swarm"],
  ["settings", "Settings"]
];

const agentRows = [
  ["Research Agent", "Alpha-4", "Binance reads, B402/x402 intelligence", "IDLE"],
  ["Risk Agent", "Aegis-Risk", "Spread, funding, ADL, exposure invariants", "SCORING"],
  ["Execution Agent", "Hermes-v0.9", "Binance Spot Testnet adapter", "ARMED"],
  ["Clearing Engine", "ODDISEUS Core", "Intent → execution → proof governance", "AWAITING SIG"]
];

function App() {
  const [run, setRun] = useState(null);
  const [activeView, setActiveView] = useState("console");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function call(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed");
    return payload;
  }

  async function mutate(path, options = {}) {
    if (!run && path !== "/api/runs") return;
    setLoading(true);
    setError("");
    try {
      const payload = await call(path, options);
      setRun(payload.run);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function startRun() {
    setLoading(true);
    setError("");
    try {
      const payload = await call("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          intent:
            "Clear a BTCUSDT testnet micro-action through Binance MCP-compatible execution, paid intelligence, deterministic risk policy, human clearance, and a verifiable receipt.",
          symbol: "BTCUSDT",
          quoteBudgetUsdt: 10
        })
      });
      setRun(payload.run);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    startRun();
  }, []);

  const receiptHref = useMemo(() => {
    if (!run?.receipt) return null;
    return URL.createObjectURL(
      new Blob([JSON.stringify(run.receipt, null, 2)], { type: "application/json" })
    );
  }, [run?.receipt]);

  const needsApproval = run?.status === "needs_approval";
  const isTerminal = run?.status === "complete" || run?.status === "blocked";
  const progress = Math.round(((run?.completedStages?.length || 0) / STAGES.length) * 100);
  const runAction = (action, extra = {}) =>
    mutate("/api/runs", {
      method: "POST",
      body: JSON.stringify({ id: run.id, action, ...extra })
    });

  return (
    <main className="terminal-shell">
      <TopBar activeView={activeView} setActiveView={setActiveView} />

      <section className="terminal-body">
        <RunBanner
          loading={loading}
          needsApproval={needsApproval}
          isTerminal={isTerminal}
          receiptHref={receiptHref}
          run={run}
          onAdvance={() => runAction("step")}
          onApprove={() => runAction("approve")}
          onReject={() => runAction("reject")}
          onStart={startRun}
          onStop={() => runAction("stop")}
        />

        {error ? <AlertStrip message={error} /> : null}

        {activeView === "console" ? <ConsoleView run={run} progress={progress} /> : null}
        {activeView === "policy" ? <PolicyView run={run} /> : null}
        {activeView === "receipts" ? <ReceiptsView run={run} receiptHref={receiptHref} /> : null}
        {activeView === "agents" ? <AgentsView run={run} /> : null}
        {activeView === "settings" ? <SettingsView /> : null}
      </section>

      <footer className="terminal-footer">
        <span>ODDISEUS CLEARING ENGINE © 2026</span>
        <span>SOVEREIGN SETTLEMENT KERNEL</span>
        <strong>LATENCY: 14ms</strong>
        <em>CRYPTOGRAPHIC INVARIANT VERIFIED</em>
      </footer>
    </main>
  );
}

function TopBar({ activeView, setActiveView }) {
  return (
    <header className="topbar">
      <div className="wordmark">
        <strong>ODDISEUS</strong>
        <span>v0.9.4</span>
        <small>TESTNET CLEARING LAYER</small>
      </div>

      <nav className="nav-tabs" aria-label="ODDISEUS sections">
        {navItems.map(([id, label]) => (
          <button
            className={activeView === id ? "active" : ""}
            key={id}
            onClick={() => setActiveView(id)}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="telemetry-bar">
        <StatusPill label="NET" value="BSC TESTNET" tone="green" />
        <StatusPill label="POLICY" value="ENFORCING" />
        <StatusPill label="CAP" value="$10 USDT" />
        <StatusPill label="UTC" value={new Date().toISOString().slice(11, 19)} />
      </div>
    </header>
  );
}

function RunBanner({
  loading,
  needsApproval,
  isTerminal,
  receiptHref,
  run,
  onAdvance,
  onApprove,
  onReject,
  onStart,
  onStop
}) {
  const status = readableStatus(run?.status);
  const actionLine =
    run?.stage === "approval"
      ? "EXECUTION HALTED FOR SOVEREIGN CLEARANCE"
      : run?.status === "blocked"
        ? "RUN BLOCKED WITH PROOF"
        : run?.status === "complete"
          ? "VOYAGE SETTLED"
          : "CLEARING ROUTE ACTIVE";

  return (
    <section className="run-banner">
      <div className="run-id">
        <strong>#{shortId(run?.id)}</strong>
        <span className={`badge ${statusTone(run?.status)}`}>{status}</span>
      </div>

      <div className="run-facts">
        <KeyValue label="PAIR" value={run?.intent?.symbol || "BTCUSDT"} />
        <KeyValue label="BUDGET" value={`${run?.intent?.quoteBudgetUsdt || 10} USDT`} />
        <KeyValue label="EXECUTION" value="TESTNET ONLY" tone="green" />
        <KeyValue label="STATE" value={actionLine} tone={needsApproval ? "amber" : undefined} />
      </div>

      <div className="action-deck">
        <button type="button" onClick={onStart} disabled={loading}>
          <RefreshCcw size={15} /> Start New Run
        </button>
        <button type="button" onClick={onAdvance} disabled={loading || !run || needsApproval || isTerminal}>
          <Play size={15} /> Advance Stage
        </button>
        <button className="primary" type="button" onClick={onApprove} disabled={loading || !needsApproval}>
          <ShieldCheck size={15} /> Approve
        </button>
        <button className="danger" type="button" onClick={onReject} disabled={loading || !run || isTerminal}>
          <X size={15} /> Reject
        </button>
        <button className="quiet-danger" type="button" onClick={onStop} disabled={loading || !run || isTerminal}>
          Stop Run
        </button>
        {receiptHref ? (
          <a className="download" href={receiptHref} download={`oddiseus-${run.id}.json`}>
            <Download size={15} /> Receipt
          </a>
        ) : null}
      </div>
    </section>
  );
}

function ConsoleView({ run, progress }) {
  return (
    <>
      <Timeline run={run} />
      <section className="console-grid">
        <div className="column-stack">
          <IntentContract run={run} />
          <MarketData run={run} />
          <PaidIntelligence run={run} />
        </div>

        <div className="column-stack">
          <HumanGate run={run} />
          <AgentSwarm run={run} />
          <PolicyMatrix run={run} />
        </div>

        <ClearingLog run={run} progress={progress} />
      </section>
    </>
  );
}

function Timeline({ run }) {
  const completed = run?.completedStages || [];
  const current = run?.stage || "intent";

  return (
    <section className="timeline">
      {STAGES.map((stage, index) => {
        const [label, sublabel] = stageMeta[stage];
        const done = completed.includes(stage);
        const active = current === stage;
        return (
          <div className={`timeline-step ${done ? "done" : ""} ${active ? "active" : ""}`} key={stage}>
            <i>{done ? <Check size={14} /> : index + 1}</i>
            <strong>{index + 1}. {label}</strong>
            <span>{done ? sublabel : active ? sublabel : "Pending"}</span>
          </div>
        );
      })}
    </section>
  );
}

function IntentContract({ run }) {
  return (
    <Panel icon={LockKeyhole} title="Intent Contract" meta="frozen input">
      <div className="intent-box">
        <span>&gt;</span>
        <p>{run?.intent?.text || "Preparing sovereign intent contract..."}</p>
      </div>
      <div className="metric-grid three">
        <Metric label="Target Asset" value={run?.intent?.symbol || "BTCUSDT"} />
        <Metric label="Max Budget" value={`${run?.intent?.quoteBudgetUsdt || 10} USDT`} />
        <Metric label="Run Mode" value="Testnet isolated" tone="green" />
        <Metric label="Intent Hash" value={run?.intentHash || "pending"} wide />
      </div>
    </Panel>
  );
}

function MarketData({ run }) {
  const market = run?.marketSnapshot;
  return (
    <Panel icon={Activity} title="Binance Market Data" meta={market?.source || "live feed pending"}>
      <div className="metric-grid four">
        <Metric label="Spot Bid" value={formatMoney(market?.spot?.bidPrice)} tone="green" />
        <Metric label="Spot Ask" value={formatMoney(market?.spot?.askPrice)} tone="red" />
        <Metric label="Spread" value={`${market?.derived?.spreadBps ?? "--"} bps`} />
        <Metric label="Mark Price" value={formatMoney(market?.futures?.markPrice)} tone="bronze" />
        <Metric label="8h Funding Rate" value={market?.futures?.lastFundingRate ?? "--"} tone="green" />
        <Metric label="Open Interest" value={market?.futures?.openInterest || "--"} />
        <Metric label="ADL Risk State" value={market?.futures?.adlRisk || "--"} tone="green" />
        <Metric label="Captured" value={market?.capturedAt ? market.capturedAt.slice(11, 19) : "--"} />
      </div>
      <Sparkline />
      <HashLine label="Snapshot Hash" value={market?.snapshotHash} />
    </Panel>
  );
}

function PaidIntelligence({ run }) {
  const item = run?.paidData?.[0];
  return (
    <Panel icon={CircleDollarSign} title="Paid Intelligence" meta="x402 / B402 protocol">
      {item ? (
        <>
          <div className="data-card">
            <KeyValue label="Oracle Provider" value={item.merchant} />
            <KeyValue label="Incurred Cost" value={`${item.priceUsdt || 0} USDT`} tone="bronze" />
            <KeyValue
              label="Status"
              value={item.status.replaceAll("_", " ")}
              tone={item.status === "acquired" ? "green" : "amber"}
            />
          </div>
          <p className="body-copy">{item.summary}</p>
          <HashLine label="Payload Hash" value={item.payloadHash} />
        </>
      ) : (
        <EmptyState icon={CircleDollarSign} text="Waiting for a paid-intelligence request." />
      )}
    </Panel>
  );
}

function HumanGate({ run }) {
  const executionValue = Number(run?.intent?.quoteBudgetUsdt || 10);
  const isBlocked = run?.status === "blocked";
  return (
    <Panel
      icon={KeyRound}
      title="Human Approval Gate"
      meta={run?.stage === "approval" ? "action required" : readableStatus(run?.status)}
    >
      <p className="gate-caption">
        {run?.stage === "approval"
          ? "EXECUTION HALTED FOR SOVEREIGN CLEARANCE"
          : isBlocked
            ? "SOVEREIGN CLEARANCE REFUSED"
            : "NO HUMAN SIGNATURE REQUIRED AT THIS MOMENT"}
      </p>
      <div className="payload-box">
        <span>PROPOSED ACTION PAYLOAD</span>
        <strong>
          Place <em>MARKET BUY</em> for <b>{executionValue.toFixed(2)} USDT</b> on {run?.intent?.symbol || "BTCUSDT"}
        </strong>
        <small>TESTNET-ONLY ADAPTER READY</small>
      </div>
      <div className="metric-grid three">
        <Metric label="Max Slippage" value="< 12 bps" />
        <Metric label="Escalation Trigger" value="Every execution" tone="amber" />
        <Metric label="Policy Ref" value="POL-HUM-08" />
      </div>
      {run?.approval ? (
        <HashLine label={run.approval.approved ? "Approval Hash" : "Rejection Hash"} value={run.approval.approvalHash} />
      ) : null}
    </Panel>
  );
}

function AgentSwarm({ run }) {
  return (
    <Panel icon={Bot} title="Agent Swarm Status" meta={`${agentRows.length} active entities`}>
      <div className="agent-table">
        {agentRows.map(([name, id, duty, state], index) => (
          <div className="agent-row" key={id}>
            <i className={index === 1 ? "green" : index === 2 ? "bronze" : ""} />
            <strong>{name}</strong>
            <span>{id}</span>
            <p>{duty}</p>
            <em>{state}</em>
          </div>
        ))}
      </div>
      {run?.reputation?.length ? (
        <div className="reputation-strip">
          {run.reputation.map((agent) => (
            <div key={agent.agentId}>
              <span>{agent.role}</span>
              <p>{agent.summary}</p>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function PolicyMatrix({ run }) {
  const decisions = run?.policyDecisions || [];
  const rows = decisions.length
    ? decisions
    : [
        { id: "pol-01", decision: "QUEUED", action: "READ_MARKET", reason: "Allowed symbol and live market read." },
        { id: "pol-02", decision: "QUEUED", action: "BUY_DATA", reason: "Spend capped by paid intelligence policy." },
        { id: "pol-03", decision: "QUEUED", action: "TESTNET_SPOT", reason: "Human approval required before dispatch." }
      ];

  return (
    <Panel icon={ShieldCheck} title="Policy Verification Matrix" meta={`${decisions.length || 0} checks evaluated`}>
      <div className="policy-cells">
        {rows.map((decision, index) => (
          <div className={`policy-cell ${decision.decision.toLowerCase()}`} key={decision.id}>
            <span>POL-{String(index + 1).padStart(2, "0")}: {decision.action}</span>
            <strong>{decision.decision}</strong>
            <p>{decision.reason}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ClearingLog({ run, progress }) {
  const lines = [
    ["system", "ODDISEUS clearing kernel online"],
    ["intent", `locked ${run?.intent?.symbol || "BTCUSDT"} / ${run?.intent?.quoteBudgetUsdt || 10} USDT / testnet`],
    ["market", run?.marketSnapshot ? `captured ${run.marketSnapshot.snapshotHash}` : "awaiting Binance market state"],
    ["data", run?.paidData?.[0] ? `paid-data ${run.paidData[0].status}` : "paid-data lane pending"],
    ["risk", run?.riskAssessment ? `${run.riskAssessment.status} spread=${run.riskAssessment.spreadBps}` : "risk agent queued"],
    ["policy", run?.policyDecisions?.length ? `${run.policyDecisions.length} policy decisions emitted` : "policy matrix queued"],
    ["execution", run?.execution ? `${run.execution.status} ${run.execution.blockedReason || run.execution.orderId || ""}` : "testnet adapter armed"],
    ["receipt", run?.receipt ? `closed ${run.receipt.receiptHash}` : `route clearance ${progress}%`]
  ];
  return (
    <Panel className="full-width" icon={SquareTerminal} title="Clearing Log" meta="audit stream">
      <div className="terminal-log">
        {lines.map(([label, line]) => (
          <p key={label}>
            <span>{label.padEnd(9, " ")}</span>
            {line}
          </p>
        ))}
      </div>
    </Panel>
  );
}

function PolicyView({ run }) {
  return (
    <section className="single-view">
      <PolicyMatrix run={run} />
      <HumanGate run={run} />
      <ClearingLog run={run} progress={Math.round(((run?.completedStages?.length || 0) / STAGES.length) * 100)} />
    </section>
  );
}

function ReceiptsView({ run, receiptHref }) {
  return (
    <section className="single-view">
      <Panel icon={Fingerprint} title="Voyage Receipts Ledger" meta={run?.receipt?.outcome || "pending"}>
        <div className="receipt-grid">
          <HashLine label="Receipt Hash" value={run?.receipt?.receiptHash} large />
          <HashLine label="Intent Hash" value={run?.receipt?.intentHash || run?.intentHash} />
          <HashLine label="Market Hash" value={run?.receipt?.marketSnapshotHash} />
          <HashLine label="Execution Proof" value={run?.execution?.proofHash} />
        </div>
        {receiptHref ? (
          <a className="download big" href={receiptHref} download={`oddiseus-${run.id}.json`}>
            <Download size={16} /> Download Verifiable Receipt JSON
          </a>
        ) : (
          <EmptyState icon={Fingerprint} text="Advance the run through execution and receipt creation." />
        )}
      </Panel>
    </section>
  );
}

function AgentsView({ run }) {
  return (
    <section className="single-view">
      <AgentSwarm run={run} />
      <PaidIntelligence run={run} />
      <MarketData run={run} />
    </section>
  );
}

function SettingsView() {
  return (
    <section className="single-view">
      <Panel icon={Gauge} title="Settings & Configuration" meta="testnet locked">
        <div className="settings-grid">
          <Setting label="Execution Network" value="Binance Spot Testnet" locked />
          <Setting label="Mainnet Execution" value="Disabled" locked danger />
          <Setting label="Withdrawals" value="Denied by invariant" locked danger />
          <Setting label="Max Run Budget" value="10 USDT" />
          <Setting label="Paid Data Cap" value="0.25 USDT" />
          <Setting label="Human Approval" value="Required for execution" locked />
        </div>
      </Panel>
    </section>
  );
}

function Panel({ children, className = "", icon: Icon, meta, title }) {
  return (
    <article className={`panel ${className}`}>
      <header className="panel-head">
        <div>
          <Icon size={17} />
          <h2>{title}</h2>
        </div>
        <span>{meta}</span>
      </header>
      {children}
    </article>
  );
}

function Metric({ label, tone, value, wide = false }) {
  return (
    <div className={`metric ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <strong className={tone ? `text-${tone}` : ""} title={String(value ?? "--")}>{value ?? "--"}</strong>
    </div>
  );
}

function KeyValue({ label, tone, value }) {
  return (
    <div className="key-value">
      <span>{label}:</span>
      <strong className={tone ? `text-${tone}` : ""}>{value}</strong>
    </div>
  );
}

function StatusPill({ label, tone, value }) {
  return (
    <div className="status-pill">
      <span>{label}:</span>
      <strong className={tone ? `text-${tone}` : ""}>{value}</strong>
    </div>
  );
}

function HashLine({ label, value, large = false }) {
  return (
    <div className={`hash-line ${large ? "large" : ""}`}>
      <span>{label}</span>
      <code title={value || "pending"}>{value || "pending"}</code>
    </div>
  );
}

function Setting({ danger = false, label, locked = false, value }) {
  return (
    <div className={`setting ${danger ? "danger" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {locked ? <LockKeyhole size={14} /> : <Eye size={14} />}
    </div>
  );
}

function EmptyState({ icon: Icon, text }) {
  return (
    <div className="empty-state">
      <Icon size={20} />
      <p>{text}</p>
    </div>
  );
}

function Sparkline() {
  return (
    <div className="sparkline">
      <span>15m Order Flow Trend</span>
      <svg fill="none" preserveAspectRatio="none" viewBox="0 0 100 20">
        <path d="M0,15 L14,12 L28,16 L42,9 L56,11 L70,4 L84,6 L100,2" />
      </svg>
    </div>
  );
}

function AlertStrip({ message }) {
  return (
    <div className="alert-strip">
      <AlertTriangle size={16} />
      <span>{message}</span>
    </div>
  );
}

function formatMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return "--";
  return `$${Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 8,
    minimumFractionDigits: 2
  })}`;
}

function readableStatus(status) {
  return String(status || "booting").replaceAll("_", " ");
}

function shortId(id) {
  if (!id) return "OD-BOOT";
  return id.replace("run_", "OD-").slice(0, 18).toUpperCase();
}

function statusTone(status) {
  if (status === "complete") return "ok";
  if (status === "blocked") return "bad";
  if (status === "needs_approval") return "warn";
  return "live";
}

createRoot(document.getElementById("root")).render(<App />);
