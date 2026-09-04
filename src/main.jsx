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
  intent: "Intent",
  market: "Market Data",
  "paid-data": "External Intel",
  risk: "Risk Check",
  policy: "Policy Check",
  approval: "Human Approval",
  execution: "Execution",
  receipt: "Receipt"
};

const navItems = [
  ["console", "Console"],
  ["policy", "Policy Matrix"],
  ["receipts", "Receipts"],
  ["agents", "Execution Modules"],
  ["settings", "Settings"]
];

function App() {
  const [run, setRun] = useState(null);
  const [config, setConfig] = useState(null);
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

  async function startRun(runtimeConfig = config) {
    if (!runtimeConfig) {
      setError("Runtime config is not loaded; ODDISEUS will not start a run from guessed values.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload = await call("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          intent: runtimeConfig.defaults.intentText,
          symbol: runtimeConfig.defaults.symbol,
          quoteBudgetUsdt: runtimeConfig.defaults.quoteBudgetUsdt
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
    let cancelled = false;

    async function boot() {
      setLoading(true);
      setError("");
      try {
        const runtimeConfig = await call("/api/config");
        if (cancelled) return;
        setConfig(runtimeConfig);

        const payload = await call("/api/runs", {
          method: "POST",
          body: JSON.stringify({
            intent: runtimeConfig.defaults.intentText,
            symbol: runtimeConfig.defaults.symbol,
            quoteBudgetUsdt: runtimeConfig.defaults.quoteBudgetUsdt
          })
        });
        if (!cancelled) setRun(payload.run);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    boot();
    return () => {
      cancelled = true;
    };
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
      body: JSON.stringify({ id: run.id, run, action, ...extra })
    });

  return (
    <main className="terminal-shell">
      <TopBar activeView={activeView} config={config} setActiveView={setActiveView} />

      <section className="terminal-body">
        <RunBanner
          config={config}
          loading={loading}
          needsApproval={needsApproval}
          isTerminal={isTerminal}
          receiptHref={receiptHref}
          run={run}
          onAdvance={() => runAction("step")}
          onApprove={() => runAction("approve")}
          onReject={() => runAction("reject")}
          onStart={() => startRun(config)}
          onStop={() => runAction("stop")}
        />

        {error ? <AlertStrip message={error} /> : null}

        {activeView === "console" ? <ConsoleView config={config} run={run} progress={progress} /> : null}
        {activeView === "policy" ? <PolicyView config={config} run={run} /> : null}
        {activeView === "receipts" ? <ReceiptsView run={run} receiptHref={receiptHref} /> : null}
        {activeView === "agents" ? <AgentsView config={config} run={run} /> : null}
        {activeView === "settings" ? <SettingsView config={config} /> : null}
      </section>

      <footer className="terminal-footer">
        <span>ODDISEUS CLEARING ENGINE © 2026</span>
        <span>TESTNET-ONLY CLEARING KERNEL</span>
        <strong>NO MOCK EXECUTION</strong>
        <em>UNCONNECTED LANES ARE MARKED, NOT FABRICATED</em>
      </footer>
    </main>
  );
}

function TopBar({ activeView, config, setActiveView }) {
  const capValue = config?.policy?.maxRunBudgetUsdt ? `$${config.policy.maxRunBudgetUsdt} USDT` : "CONFIG PENDING";
  return (
    <header className="topbar">
      <div className="wordmark">
        <strong>ODDISEUS</strong>
        <span>{config?.version ? `v${config.version}` : "config pending"}</span>
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
        <StatusPill label="NET" value={config?.network?.label || "CONFIG PENDING"} tone={config ? "green" : "amber"} />
        <StatusPill label="POLICY" value={config?.truthMode === "fail_closed_no_mock" ? "NO-MOCK" : "PENDING"} />
        <StatusPill label="CAP" value={capValue} />
        <StatusPill label="UTC" value={new Date().toISOString().slice(11, 19)} />
      </div>
    </header>
  );
}

function RunBanner({
  config,
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
  const executionStatus = config?.integrations?.executionAdapter?.status;
  const executionLabel = executionStatus === "live" ? "REAL TESTNET" : readableStatus(executionStatus || "config pending").toUpperCase();
  const actionLine =
    run?.stage === "approval"
      ? "EXECUTION HALTED FOR SOVEREIGN CLEARANCE"
      : run?.status === "blocked"
        ? "RUN BLOCKED WITH PROOF"
        : run?.status === "complete"
          ? "RECEIPT CREATED"
          : "CLEARING ROUTE ACTIVE";

  return (
    <section className="run-banner">
      <div className="run-id">
        <strong>#{shortId(run?.id)}</strong>
        <span className={`badge ${statusTone(run?.status)}`}>{status}</span>
      </div>

      <div className="run-facts">
        <KeyValue label="PAIR" value={run?.intent?.symbol || config?.defaults?.symbol || "--"} />
        <KeyValue label="BUDGET" value={`${run?.intent?.quoteBudgetUsdt || config?.defaults?.quoteBudgetUsdt || "--"} USDT`} />
        <KeyValue label="EXECUTION" value={executionLabel} tone={executionStatus === "live" ? "green" : "amber"} />
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

function ConsoleView({ config, run, progress }) {
  return (
    <>
      <Timeline run={run} />
      <section className="console-grid">
        <div className="column-stack">
          <IntentContract config={config} run={run} />
          <MarketData run={run} />
          <PaidIntelligence run={run} />
        </div>

        <div className="column-stack">
          <HumanGate config={config} run={run} />
          <AgentSwarm config={config} run={run} />
          <PolicyMatrix config={config} run={run} />
        </div>

        <ClearingLog config={config} run={run} progress={progress} />
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
        const label = stageMeta[stage];
        const done = completed.includes(stage);
        const active = current === stage;
        const sublabel = getStageSublabel(run, stage, done, active);
        const tone = getStageTone(run, stage);
        return (
          <div className={`timeline-step ${done ? "done" : ""} ${active ? "active" : ""} ${tone}`} key={stage}>
            <i>{done ? <Check size={14} /> : index + 1}</i>
            <strong>{index + 1}. {label}</strong>
            <span>{sublabel}</span>
          </div>
        );
      })}
    </section>
  );
}

function IntentContract({ config, run }) {
  const symbol = run?.intent?.symbol || config?.defaults?.symbol || "--";
  const budget = run?.intent?.quoteBudgetUsdt || config?.defaults?.quoteBudgetUsdt;
  return (
    <Panel icon={LockKeyhole} title="Intent Contract" meta="frozen input">
      <div className="intent-box">
        <span>&gt;</span>
        <p>{run?.intent?.text || "Preparing sovereign intent contract..."}</p>
      </div>
      <div className="metric-grid three">
        <Metric label="Target Asset" value={symbol} />
        <Metric label="Max Budget" value={budget ? `${budget} USDT` : "--"} />
        <Metric label="Run Mode" value={readableStatus(config?.network?.executionMode || run?.intent?.mode || "pending")} tone="green" />
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
      <DataProof market={market} />
      <HashLine label="Snapshot Hash" value={market?.snapshotHash} />
    </Panel>
  );
}

function PaidIntelligence({ run }) {
  const item = run?.paidData?.[0];
  return (
    <Panel icon={CircleDollarSign} title="External Intelligence" meta={paidIntelMeta(item)}>
      {item ? (
        <>
          <div className="data-card">
            <KeyValue label="Oracle Provider" value={item.merchant} />
            <KeyValue label="Incurred Cost" value={`${item.priceUsdt || 0} USDT`} tone="bronze" />
            <KeyValue
              label="Status"
              value={readableStatus(item.status)}
              tone={item.status === "acquired" ? "green" : "amber"}
            />
          </div>
          <p className="body-copy">{item.summary}</p>
          <HashLine label="Payload Hash" value={item.payloadHash} />
        </>
      ) : (
        <EmptyState icon={CircleDollarSign} text="Waiting for a real external-intelligence connector check." />
      )}
    </Panel>
  );
}

function HumanGate({ config, run }) {
  const executionValue = Number(run?.intent?.quoteBudgetUsdt || config?.defaults?.quoteBudgetUsdt || 0);
  const symbol = run?.intent?.symbol || config?.defaults?.symbol || "--";
  const policyRef = config?.policy?.humanApprovalRef || "policy pending";
  const maxSlippage = config?.policy?.maxSpreadBps;
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
            : "OPERATOR APPROVAL NOT REQUESTED YET"}
      </p>
      <div className="payload-box">
        <span>PROPOSED ACTION PAYLOAD</span>
        <strong>
          Place <em>MARKET BUY</em> for <b>{executionValue.toFixed(2)} USDT</b> on {symbol}
        </strong>
        <small>{config?.integrations?.executionAdapter?.label || "execution adapter pending"}</small>
      </div>
      <div className="metric-grid three">
        <Metric label="Max Spread" value={maxSlippage ? `< ${maxSlippage} bps` : "--"} />
        <Metric
          label="Escalation Trigger"
          value={config?.policy?.realExecutionRequiresApproval ? "Every execution" : "Policy disabled"}
          tone="amber"
        />
        <Metric label="Policy Ref" value={policyRef} />
      </div>
      {run?.approval ? (
        <HashLine label={run.approval.approved ? "Operator Approval Hash" : "Operator Rejection Hash"} value={run.approval.approvalHash} />
      ) : null}
    </Panel>
  );
}

function AgentSwarm({ config, run }) {
  const moduleRows = getModuleRows(run, config);
  return (
    <Panel icon={Bot} title="Execution Modules" meta={`${moduleRows.length} stateful lanes`}>
      <div className="agent-table">
        {moduleRows.map(({ duty, id, name, state, tone }) => (
          <div className="agent-row" key={id}>
            <i className={tone} />
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

function PolicyMatrix({ config, run }) {
  const decisions = run?.policyDecisions || [];
  const rows = decisions.length
    ? decisions
    : getQueuedPolicyRows(config);

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

function ClearingLog({ config, run, progress }) {
  const symbol = run?.intent?.symbol || config?.defaults?.symbol || "--";
  const budget = run?.intent?.quoteBudgetUsdt || config?.defaults?.quoteBudgetUsdt || "--";
  const adapter = config?.integrations?.executionAdapter?.label || "execution adapter config pending";
  const lines = [
    ["system", "ODDISEUS clearing kernel online"],
    ["intent", `locked ${symbol} / ${budget} USDT / testnet`],
    ["market", run?.marketSnapshot ? `captured ${run.marketSnapshot.snapshotHash}` : "awaiting Binance market state"],
    ["data", run?.paidData?.[0] ? `external-intel ${run.paidData[0].status}` : "external-intel connector pending"],
    ["risk", run?.riskAssessment ? `${run.riskAssessment.status} spread=${run.riskAssessment.spreadBps}` : "risk engine queued"],
    ["policy", run?.policyDecisions?.length ? `${run.policyDecisions.length} policy decisions emitted` : "policy matrix queued"],
    ["execution", run?.execution ? `${run.execution.status} ${run.execution.blockedReason || run.execution.orderId || ""}` : `${adapter} armed`],
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

function PolicyView({ config, run }) {
  return (
    <section className="single-view">
      <PolicyMatrix config={config} run={run} />
      <HumanGate config={config} run={run} />
      <ClearingLog config={config} run={run} progress={Math.round(((run?.completedStages?.length || 0) / STAGES.length) * 100)} />
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

function AgentsView({ config, run }) {
  return (
    <section className="single-view">
      <AgentSwarm config={config} run={run} />
      <PaidIntelligence run={run} />
      <MarketData run={run} />
    </section>
  );
}

function SettingsView({ config }) {
  const policyConfig = config?.policy;
  const integrations = config?.integrations || {};
  return (
    <section className="single-view">
      <Panel icon={Gauge} title="Settings & Configuration" meta={config?.truthMode || "config pending"}>
        <div className="settings-grid">
          <Setting label="Execution Network" value={config?.network?.executionNetwork || "Config pending"} locked />
          <Setting label="Mainnet Execution" value={config?.network?.mainnetEnabled ? "Enabled" : "Disabled"} locked danger />
          <Setting label="Withdrawals" value={config?.network?.withdrawalsEnabled ? "Enabled" : "Denied by invariant"} locked danger />
          <Setting label="Max Run Budget" value={policyConfig?.maxRunBudgetUsdt ? `${policyConfig.maxRunBudgetUsdt} USDT` : "--"} />
          <Setting label="External Intel" value={capabilityLabel(integrations.b402)} />
          <Setting label="MCP Transport" value={capabilityLabel(integrations.mcp)} />
          <Setting label="Human Approval" value={policyConfig?.realExecutionRequiresApproval ? "Operator click required" : "Not required"} locked />
          <Setting label="Wallet Signature" value={capabilityLabel(integrations.walletSignature)} />
          <Setting label="Receipt Storage" value={capabilityLabel(integrations.persistence)} />
          <Setting label="On-chain Anchor" value={capabilityLabel(integrations.onchainAnchoring)} />
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

function DataProof({ market }) {
  return (
    <div className="data-proof">
      <span>Live Source Proof</span>
      <p>
        {market
          ? `Captured ${market.source} at ${market.capturedAt}. No synthetic charting or fabricated order-flow trend is rendered.`
          : "No market payload captured yet. ODDISEUS waits for Binance Testnet before showing data."}
      </p>
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

function paidIntelMeta(item) {
  if (!item) return "connector pending";
  if (item.status === "acquired") return "real B402/x402 response";
  if (item.status === "not_configured" || item.status === "blocked_external_not_configured") return "not configured";
  return "blocked or challenged";
}

function capabilityLabel(capability) {
  if (!capability) return "Config pending";
  if (capability.status === "live") return "Live";
  if (capability.status === "blocked") return "Blocked";
  return "Not configured";
}

function getQueuedPolicyRows(config) {
  const allowedActions = config?.policy?.allowedActions || [];
  if (!allowedActions.length) {
    return [
      {
        id: "policy-config-pending",
        decision: "QUEUED",
        action: "CONFIG",
        reason: "Waiting for backend policy config. ODDISEUS will not invent policy values."
      }
    ];
  }

  return allowedActions.map((action) => {
    if (action === "READ_MARKET") {
      return {
        id: "queued-read-market",
        decision: "QUEUED",
        action,
        reason: "Backend policy allows live market reads for configured symbols."
      };
    }
    if (action === "EXTERNAL_INTEL") {
      return {
        id: "queued-external-intel",
        decision: "QUEUED",
        action,
        reason:
          config?.integrations?.b402?.status === "live"
            ? "B402/x402 endpoint is configured and can be evaluated by policy."
            : "B402/x402 endpoint is not configured; policy will skip without fabricating data."
      };
    }
    if (action === "TESTNET_SPOT") {
      return {
        id: "queued-testnet-spot",
        decision: "QUEUED",
        action,
        reason: config?.policy?.realExecutionRequiresApproval
          ? "Human operator approval is required before real Spot Testnet dispatch."
          : "Backend policy does not require human approval."
      };
    }
    return {
      id: `queued-${action.toLowerCase()}`,
      decision: "QUEUED",
      action,
      reason: "Action is listed by backend policy."
    };
  });
}

function getStageSublabel(run, stage, done, active) {
  if (!run) return stage === "intent" ? "BOOTING" : "PENDING";
  const item = run.paidData?.[0];
  const execution = run.execution;

  if (stage === "intent") return done || active ? "VERIFIED" : "PENDING";
  if (stage === "market") return run.marketSnapshot ? "LIVE CAPTURED" : active ? "READING LIVE" : "PENDING";
  if (stage === "paid-data") {
    if (item?.status === "acquired") return "ACQUIRED";
    if (item?.status === "not_configured" || item?.status === "blocked_external_not_configured") return "NOT CONFIGURED";
    if (item) return "BLOCKED";
    return active ? "CHECKING" : "PENDING";
  }
  if (stage === "risk") return run.riskAssessment ? run.riskAssessment.status.toUpperCase() : active ? "SCORING" : "PENDING";
  if (stage === "policy") return run.policyDecisions?.length ? "EVALUATED" : active ? "EVALUATING" : "PENDING";
  if (stage === "approval") {
    if (run.approval?.approved) return "OPERATOR APPROVED";
    if (run.approval?.approved === false) return "REJECTED";
    return active ? "ACTION REQUIRED" : "PENDING";
  }
  if (stage === "execution") {
    if (execution?.status === "testnet_executed") return "TESTNET EXECUTED";
    if (execution?.status === "blocked") return "BLOCKED";
    return active ? "READY" : "PENDING";
  }
  if (stage === "receipt") return run.receipt ? run.receipt.outcome : active ? "BUILDING" : "STANDBY";
  return done ? "DONE" : active ? "ACTIVE" : "PENDING";
}

function getStageTone(run, stage) {
  const item = run?.paidData?.[0];
  if (stage === "paid-data" && item && item.status !== "acquired") return "warn";
  if (stage === "execution" && run?.execution?.status === "blocked") return "warn";
  return "";
}

function getModuleRows(run, config) {
  const item = run?.paidData?.[0];
  const integrations = config?.integrations || {};
  const externalIntelState =
    item?.status === "acquired"
      ? "ACQUIRED"
      : item?.status
        ? "NOT CONFIGURED"
        : run?.stage === "paid-data"
          ? "CHECKING"
          : "PENDING";

  return [
    {
      name: "Market Reader",
      id: integrations.binanceSpot?.id || "market-reader-config-pending",
      duty: integrations.binanceSpot?.label || "Waiting for backend market-data capability config",
      state: run?.marketSnapshot ? "CAPTURED" : run?.stage === "market" ? "READING" : "PENDING",
      tone: run?.marketSnapshot ? "green" : run?.stage === "market" ? "bronze" : ""
    },
    {
      name: "External Intel Connector",
      id: integrations.b402?.id || "external-intel-config-pending",
      duty: integrations.b402?.label || "Waiting for backend external-intelligence capability config",
      state: externalIntelState,
      tone: item?.status === "acquired" ? "green" : item?.status ? "bronze" : ""
    },
    {
      name: "Risk Policy Engine",
      id: "deterministic-risk-policy",
      duty: "Scores spread, funding, ADL state, and budget invariants",
      state: run?.riskAssessment ? "SCORED" : run?.stage === "risk" ? "SCORING" : "PENDING",
      tone: run?.riskAssessment ? "green" : run?.stage === "risk" ? "bronze" : ""
    },
    {
      name: "Execution Adapter",
      id: integrations.executionAdapter?.id || "execution-adapter-config-pending",
      duty: integrations.executionAdapter?.label || "Waiting for backend execution capability config",
      state:
        run?.execution?.status === "testnet_executed"
          ? "EXECUTED"
          : run?.execution?.status === "blocked"
            ? "BLOCKED"
            : run?.stage === "execution" || run?.stage === "approval"
              ? "ARMED"
              : "PENDING",
      tone:
        run?.execution?.status === "testnet_executed"
          ? "green"
          : run?.execution?.status === "blocked" || run?.stage === "execution" || run?.stage === "approval"
            ? "bronze"
            : ""
    }
  ];
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
