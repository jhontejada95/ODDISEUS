import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

test("stable receipt hashes change when execution proof changes", () => {
  const base = {
    receiptVersion: "oddiseus-v0.1",
    runId: "run_demo",
    execution: { status: "testnet_executed", proofHash: "sha256:a" }
  };
  const a = hash(base);
  const b = hash({
    ...base,
    execution: { status: "testnet_executed", proofHash: "sha256:b" }
  });
  assert.notEqual(a, b);
});

test("stable stringify is key-order independent", () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});

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
