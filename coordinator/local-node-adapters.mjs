import { analyzeAddress } from "../address-intelligence/scripts/lib/analyze.mjs";
import { inspectContract } from "../contract-inspector/lib/inspect-core.js";
import { defineAdapter } from "./adapters.mjs";

const ADDRESS_NETWORKS = {
  mainnet: "pacific_mainnet",
  testnet: "atlantic_testnet",
};

export function createLocalNodeAdapters() {
  return {
    address: defineAdapter({
      module: "address-intelligence",
      version: "0.1.0",
      assess: (request, context) =>
        analyzeAddress(
          request.target.address,
          ADDRESS_NETWORKS[request.target.network || "testnet"],
          {
            offline: request.options?.offline === true,
            signal: context.signal,
          },
        ),
    }),
    contract: defineAdapter({
      module: "contract-inspector",
      version: "1.1.0",
      assess: (request, context) =>
        inspectContract({
          address: request.target.address,
          network: request.target.network || "testnet",
          online: request.options?.offline !== true,
          signal: context.signal,
        }),
    }),
  };
}
