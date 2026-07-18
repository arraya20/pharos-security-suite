#!/usr/bin/env node
import assert from "node:assert/strict";
import { formatUnits } from "./lib/format.js";

assert.equal(formatUnits(10368627647762882n, 6), "10,368,627,647.762882");
assert.equal(formatUnits("1000000000000000001", 18), "1.000000000000000001");
assert.equal(formatUnits(0n, 18), "0");
assert.equal(formatUnits(123n, 0), "123");
assert.equal(formatUnits(123456789n, 4), "12,345.6789");

console.log("format tests passed");
