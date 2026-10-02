const __esm_import_meta_url = require('url').pathToFileURL(__filename).href;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// dist/testing/dev-accounts.js
var dev_accounts_exports = {};
__export(dev_accounts_exports, {
  DEFAULT_CHAIN: () => DEFAULT_CHAIN,
  DEV_ACCOUNTS: () => DEV_ACCOUNTS,
  DEV_ACCOUNT_NAMES: () => DEV_ACCOUNT_NAMES,
  LIVE_CHAINS: () => LIVE_CHAINS,
  PASEO_ASSET_HUB: () => PASEO_ASSET_HUB,
  isDevAccountName: () => isDevAccountName,
  liveChain: () => liveChain,
  resolveAccount: () => resolveAccount
});
module.exports = __toCommonJS(dev_accounts_exports);
function entropyFor(marker) {
  return new Uint8Array(32).fill(marker);
}
var DEV_ACCOUNTS = {
  alice: entropyFor(161),
  bob: entropyFor(178),
  charlie: entropyFor(195),
  dave: entropyFor(212)
};
var DEV_ACCOUNT_NAMES = Object.keys(DEV_ACCOUNTS);
function isDevAccountName(name) {
  return name in DEV_ACCOUNTS;
}
function resolveAccount(spec) {
  if (typeof spec !== "string") {
    if (spec.entropy.length !== 32) {
      throw new Error(`dev account ${spec.name} needs 32 bytes of entropy, got ${spec.entropy.length}`);
    }
    return spec;
  }
  const entropy = DEV_ACCOUNTS[spec];
  if (!entropy) {
    throw new Error(`unknown dev account "${spec}"; known: ${Object.keys(DEV_ACCOUNTS).join(", ")}`);
  }
  return { name: spec, entropy };
}
var LIVE_CHAINS = {
  /** Paseo Asset Hub. */
  paseoAssetHub: {
    rpcUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io",
    /**
     * Declare this in the host's runtime config when proxying to this chain.
     *
     * Not used for proxy routing -- an unhashed proxy takes every request, so
     * routing survives a reset. This value is needed because the *product*
     * checks it: `@parity/product-sdk-descriptors` refuses a host whose
     * declared genesis disagrees with the descriptor it was built against.
     *
     * It goes stale when the chain is reset, and it has more than once. When a
     * product reports a genesis mismatch, read the chain's current hash with
     * `chain_getBlockHash(0)` and re-pin it here.
     */
    genesisHash: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a"
  }
};
var PASEO_ASSET_HUB = {
  id: "paseo-asset-hub",
  name: "Paseo Asset Hub",
  genesisHash: LIVE_CHAINS.paseoAssetHub.genesisHash,
  rpcUrl: LIVE_CHAINS.paseoAssetHub.rpcUrl,
  tokenSymbol: "PAS",
  tokenDecimals: 10
};
var DEFAULT_CHAIN = PASEO_ASSET_HUB;
function liveChain(chain) {
  const genesisHash = chain.genesisHash;
  return {
    mock: {
      // No hash on the proxy: it takes every request, so routing survives a
      // reset even while the declared hash below has to be re-pinned.
      chainProxies: [{ rpcUrl: chain.rpcUrl }],
      supportedChains: {
        network: "paseo",
        chains: [{ identifier: "AssetHub", genesisHash }]
      }
    },
    runtimeConfig: { assetHub: { genesisHash } }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_CHAIN,
  DEV_ACCOUNTS,
  DEV_ACCOUNT_NAMES,
  LIVE_CHAINS,
  PASEO_ASSET_HUB,
  isDevAccountName,
  liveChain,
  resolveAccount
});
