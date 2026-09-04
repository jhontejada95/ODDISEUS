import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.VERCEL = "1";
process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const { default: app } = await import("../server/index.js");

test("wallet approval requires a challenge, rejects unsigned approval, and accepts verified EVM signature", async () => {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const clickOnly = await post(baseUrl, {
      id: "run_wallet_click_only_test",
      run: makeApprovalRun("run_wallet_click_only_test"),
      action: "approve"
    });

    assert.equal(clickOnly.status, 422);
    assert.match(clickOnly.payload.error, /Missing wallet approval challenge/);

    const unsignedPrepared = await post(baseUrl, {
      id: "run_wallet_unsigned_test",
      run: makeApprovalRun("run_wallet_unsigned_test"),
      action: "prepare_approval",
      address: "0x0000000000000000000000000000000000000001",
      chainId: 97,
      connector: "test-unsigned-wallet"
    });
    const unsignedApproval = await post(baseUrl, {
      id: unsignedPrepared.payload.run.id,
      run: unsignedPrepared.payload.run,
      action: "approve"
    });

    assert.equal(unsignedApproval.status, 422);
    assert.match(unsignedApproval.payload.error, /Wallet address, signature, and signed message are required/);

    const account = privateKeyToAccount(generatePrivateKey());
    const prepared = await post(baseUrl, {
      id: "run_wallet_signature_test",
      run: makeApprovalRun("run_wallet_signature_test"),
      action: "prepare_approval",
      address: account.address,
      chainId: 97,
      connector: "test-ephemeral-wallet"
    });

    assert.equal(prepared.status, 200);
    assert.equal(typeof prepared.payload.approvalMessage, "string");

    const signature = await account.signMessage({ message: prepared.payload.approvalMessage });
    const approved = await post(baseUrl, {
      id: prepared.payload.run.id,
      run: prepared.payload.run,
      action: "approve",
      address: account.address,
      chainId: 97,
      connector: "test-ephemeral-wallet",
      message: prepared.payload.approvalMessage,
      signature
    });

    assert.equal(approved.status, 200);
    assert.equal(approved.payload.run.stage, "execution");
    assert.equal(approved.payload.run.status, "running");
    assert.equal(approved.payload.run.approval.approved, true);
    assert.equal(approved.payload.run.approval.signerAddress.toLowerCase(), account.address.toLowerCase());
    assert.equal(typeof approved.payload.run.approval.signatureHash, "string");
    assert.equal(approved.payload.run.pendingApproval, undefined);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

async function post(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    payload: await response.json()
  };
}

function makeApprovalRun(id) {
  return {
    id,
    stage: "approval",
    status: "needs_approval",
    completedStages: ["intent", "market", "paid-data", "risk", "policy"],
    intent: {
      text: "Authorize BTCUSDT Spot Testnet execution.",
      symbol: "BTCUSDT",
      quoteBudgetUsdt: 10,
      mode: "binance-spot-testnet"
    },
    intentHash: "sha256:test-intent",
    marketSnapshot: {
      snapshotHash: "sha256:test-market"
    },
    riskAssessment: {
      assessmentHash: "sha256:test-risk"
    },
    policyDecisions: [
      {
        id: "decision_wallet_test",
        decision: "ESCALATE",
        action: "TESTNET_SPOT",
        reason: "Testnet execution requires wallet approval."
      }
    ],
    paidData: [],
    events: []
  };
}
