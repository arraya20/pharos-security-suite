#!/usr/bin/env node
import assert from "node:assert/strict";
import { assessRisk } from "./lib/risk.js";

function base(overrides = {}) {
  return {
    proxy: { isProxy: false, type: null, impl: null, admin: null },
    dis: { hasDelegateCall: false, hasSelfdestruct: false, hasCreate: false, hasCreate2: false, selectors: [] },
    implDis: null,
    dangerous: [],
    standards: [],
    meta: { name: null, symbol: null, decimals: null, totalSupply: null, owner: null, errors: [] },
    ...overrides,
  };
}

{
  const r = assessRisk(base({ standards: ["ERC-20"], meta: { owner: null } }));
  assert.equal(r.level, "Low");
  assert.ok(r.score < 40);
}

{
  const r = assessRisk(base({
    proxy: { isProxy: true, type: "OZ legacy proxy", impl: "0x1111111111111111111111111111111111111111", admin: null },
    dis: { hasDelegateCall: true, hasSelfdestruct: false, hasCreate: false, hasCreate2: false, selectors: ["0x3659cfe6"] },
    implDis: { hasDelegateCall: false, hasSelfdestruct: false, hasCreate: false, hasCreate2: false, selectors: ["0x40c10f19", "0x8456cb59", "0xf2fde38b"] },
    dangerous: [{ selector: "0x3659cfe6", reason: "upgradeTo (logic swap)" }],
    meta: { owner: "0x2222222222222222222222222222222222222222" },
  }));
  assert.equal(r.level, "High");
  assert.ok(r.score >= 70);
  assert.ok(r.flags.some((f) => f.check.includes("Proxy")));
  assert.ok(r.flags.some((f) => f.check.includes("Privileged selectors")));
}

{
  const r = assessRisk(base({
    dis: { hasDelegateCall: false, hasSelfdestruct: true, hasCreate: true, hasCreate2: false, selectors: [] },
  }));
  assert.equal(r.level, "Medium");
  assert.ok(r.flags.some((f) => f.check.includes("SELFDESTRUCT")));
}

{
  const r = assessRisk(base({
    resolvedFunctions: [
      { selector: "0x87517c45", signature: "approve(address,address,uint160,uint48)" },
      { selector: "0x36c78516", signature: "transferFrom(address,address,uint160,address)" },
      { selector: "0x2b67b570", signature: "permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)" },
    ],
  }));
  assert.equal(r.level, "Medium");
  assert.ok(r.flags.some((f) => f.check.includes("Value-moving selectors")));
}

{
  const r = assessRisk(base({
    unresolvedSelectors: Array.from({ length: 15 }, (_, i) => `0x${String(i).padStart(8, "0")}`),
  }));
  assert.equal(r.level, "Medium");
  assert.ok(r.flags.some((f) => f.check.includes("Unresolved selectors")));
}

// Lock the DRY refactor: ADMIN_PRIVILEGED_SELECTORS is a deliberate SUBSET of
// PRIVILEGED. renounceOwnership (0x715018a6) and setApprovalForAll (0xa22cb465)
// live in PRIVILEGED but must NOT raise an impl-side admin flag on their own.
{
  const r = assessRisk(base({
    proxy: { isProxy: true, type: "EIP-1967 proxy", impl: "0x1111111111111111111111111111111111111111", admin: null },
    implDis: { hasDelegateCall: false, hasSelfdestruct: false, hasCreate: false, hasCreate2: false, selectors: ["0x715018a6", "0xa22cb465"] },
  }));
  const privFlag = r.flags.find((f) => f.check === "Privileged selectors");
  assert.ok(privFlag, "privileged selectors flag should exist");
  assert.equal(privFlag.status, "pass", "renounce/setApprovalForAll must not trigger an impl admin flag");
}

// And the inverse: a real admin selector in the impl DOES flag.
{
  const r = assessRisk(base({
    proxy: { isProxy: true, type: "EIP-1967 proxy", impl: "0x1111111111111111111111111111111111111111", admin: null },
    implDis: { hasDelegateCall: false, hasSelfdestruct: false, hasCreate: false, hasCreate2: false, selectors: ["0x40c10f19"] },
  }));
  const privFlag = r.flags.find((f) => f.check === "Privileged selectors");
  assert.equal(privFlag.status, "warn", "mint() in impl must trigger an admin flag");
}

// Metadata-incomplete: when owner() RPC-fails (errors includes 'owner'), the
// score must NOT silently drop the +12 admin flag. We surface a "Metadata read
// incomplete" warning so the user knows admin exposure is unknown rather than
// confidently absent. This is the exact scenario that motivated the fix:
// during live testing, a single flaky owner() call swung USDC's score 81 -> 69.
{
  const r = assessRisk(base({
    standards: ["ERC-20"],
    meta: { name: "USDC", symbol: "USDC", decimals: 6, totalSupply: 1000n, owner: null, errors: ["owner"] },
  }));
  const flag = r.flags.find((f) => f.check === "Metadata read incomplete");
  assert.ok(flag, "metadata-incomplete flag must exist when owner() failed");
  assert.equal(flag.status, "info");
  assert.ok(flag.details.includes("under-reported"), "details should warn about under-reporting");
  // The ERC-20 simplicity bonus must NOT fire when owner() is unknown — we
  // can't confidently call this contract simple if we couldn't read owner().
  assert.ok(
    !r.flags.some((f) => f.check === "ERC-20 simplicity"),
    "ERC-20 simplicity bonus must not apply when owner() RPC-failed",
  );
}

// Sanity: clean ERC-20 (no errors, no owner, no proxy, no privileged) DOES get
// the simplicity bonus. The previous test would falsely pass if the condition
// were always-skip.
{
  const r = assessRisk(base({
    standards: ["ERC-20"],
    meta: { name: "T", symbol: "T", decimals: 18, totalSupply: 0n, owner: null, errors: [] },
  }));
  assert.ok(
    r.flags.some((f) => f.check === "ERC-20 simplicity"),
    "ERC-20 simplicity bonus should fire when owner() succeeded with null",
  );
}

console.log("risk tests passed");
