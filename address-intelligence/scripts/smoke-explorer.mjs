#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc } from "./lib/rpc.mjs";
import { createSocialScanProvider } from "./lib/socialscan.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "networks.json"), "utf8")
);
const networkKey = process.argv[2] || "pacific_mainnet";
const network = config.networks[networkKey];

if (!network) {
  console.error(`Unknown network "${networkKey}"`);
  process.exit(2);
}

const apiKey = process.env[network.explorerApiKeyEnv || "SOCIALSCAN_API_KEY"];
if (!apiKey) {
  console.error(`Missing ${network.explorerApiKeyEnv || "SOCIALSCAN_API_KEY"}`);
  process.exit(2);
}

const address =
  process.env.SMOKE_ADDRESS ||
  "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const provider = createSocialScanProvider({
  baseUrl: network.explorerApiUrl,
  apiKey,
  getLatestBlock: () => new Rpc(network.rpcUrl).getBlockNumber(),
});
const activity = await provider.activity(address);

if (!activity.available) {
  console.error(`SocialScan smoke test failed: ${activity.reason}`);
  process.exit(1);
}

console.log(
  `SocialScan smoke test passed for ${networkKey}; sampled ${activity.recentCount} transactions`
);
