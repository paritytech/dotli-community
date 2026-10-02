const __esm_import_meta_url = require('url').pathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// dist/testing/playwright.js
var playwright_exports = {};
__export(playwright_exports, {
  DEFAULT_CHAIN: () => DEFAULT_CHAIN,
  DEV_ACCOUNTS: () => DEV_ACCOUNTS,
  DEV_ACCOUNT_NAMES: () => DEV_ACCOUNT_NAMES,
  LIVE_CHAINS: () => LIVE_CHAINS,
  PASEO_ASSET_HUB: () => PASEO_ASSET_HUB,
  createTestHostFixture: () => createTestHostFixture,
  fromNetworks: () => fromNetworks,
  liveChain: () => liveChain
});
module.exports = __toCommonJS(playwright_exports);

// dist/testing/dev-accounts.js
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

// dist/testing/host-page.js
var PRODUCT_FRAME_ID = "product-frame";

// dist/testing/server.js
var import_node_http = require("node:http");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var import_node_url = require("node:url");

// dist/testing/host-page-url.js
function hostPageUrl(base, config) {
  const url = new URL(base);
  url.searchParams.set("product", config.productUrl);
  if (config.mock)
    url.searchParams.set("mock", JSON.stringify(config.mock));
  if (config.productId)
    url.searchParams.set("productId", config.productId);
  if (config.runtimeConfig) {
    url.searchParams.set("runtimeConfig", JSON.stringify(config.runtimeConfig));
  }
  if (config.accounts) {
    url.searchParams.set("accounts", config.accounts.map((account) => typeof account === "string" ? account : `${account.name}:${[...account.entropy].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`).join(","));
  }
  if (config.loginBehavior)
    url.searchParams.set("login", config.loginBehavior);
  if (config.topology)
    url.searchParams.set("topology", config.topology);
  if (config.allowances)
    url.searchParams.set("allowances", config.allowances);
  if (config.logLevel)
    url.searchParams.set("logLevel", config.logLevel);
  return url.toString();
}

// dist/testing/server.js
var __dirname = (0, import_node_path.dirname)((0, import_node_url.fileURLToPath)(__esm_import_meta_url));
var distRoot = (0, import_node_path.resolve)(__dirname, "../..", "dist");
var PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>TrUAPI test host</title>
    <style>
      html, body, #product-container { margin: 0; height: 100%; }
      #product-container > iframe { width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <div id="product-container"></div>
    <script type="module" src="/test-host.js"></script>
  </body>
</html>
`;
var CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".ts": "text/plain; charset=utf-8"
};
async function bundle(entry, wasmBundle = "testing") {
  const { build } = await import("esbuild").catch(() => {
    throw new Error("@parity/truapi-host/testing/server needs esbuild. Install it as a dev dependency alongside this package.");
  });
  const result = await build({
    entryPoints: [(0, import_node_path.join)(distRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    plugins: [
      {
        name: "truapi-wasm-path",
        setup(build2) {
          build2.onResolve({ filter: /wasm\/(web|testing)\/truapi_server\.js$/ }, () => ({
            path: `/wasm/${wasmBundle}/truapi_server.js`,
            external: true
          }));
        }
      }
    ],
    external: ["*.wasm"]
  });
  const [output] = result.outputFiles;
  if (!output)
    throw new Error(`esbuild produced no output for ${entry}`);
  return output.text;
}
async function createTestHostServer(options = {}) {
  if (options.productAccounts) {
    throw new Error("createTestHostServer `productAccounts` is not supported by the TrUAPI test host: a product account is DERIVED from (session root, product id), so it cannot be mapped to a chosen account. Read the address back from the host and fund that, rather than pinning one.");
  }
  const [pageBundle, workerBundle] = await Promise.all([
    bundle("testing/browser-entry.js"),
    bundle("worker-runtime.js")
  ]);
  const server = (0, import_node_http.createServer)((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/test-host.js") {
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".js"] });
      res.end(pageBundle);
      return;
    }
    if (path === "/test-host-worker.js") {
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".js"] });
      res.end(workerBundle);
      return;
    }
    if (path.startsWith("/wasm/")) {
      void serveFromDist(path.slice(1), res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      // The product runs cross-origin in an iframe; without this the browser
      // refuses to delegate clipboard access however the iframe is marked.
      "Permissions-Policy": "clipboard-read=*, clipboard-write=*"
    });
    res.end(PAGE);
  });
  const url = await new Promise((resolveUrl, reject) => {
    server.once("error", reject);
    if (options.unref)
      server.unref();
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test host server reported no address"));
        return;
      }
      const base = `http://127.0.0.1:${address.port}`;
      resolveUrl(options.productUrl ? hostPageUrl(base, options) : base);
    });
  });
  return {
    url,
    close: () => new Promise((done, reject) => {
      server.close((err) => err ? reject(err) : done());
    })
  };
}
async function serveFromDist(relativePath, res) {
  const target = (0, import_node_path.resolve)(distRoot, (0, import_node_path.normalize)(relativePath));
  if (target !== distRoot && !target.startsWith(distRoot + import_node_path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await (0, import_promises.readFile)(target);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[(0, import_node_path.extname)(target)] ?? "application/octet-stream"
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// dist/testing/playwright.js
var PRODUCT_FRAME = `#${PRODUCT_FRAME_ID}`;
var NO_PAYMENT_SEAM = "is not available in the TrUAPI test host: the protocol declares payments but no host implements them -- every method in the core's payment capability returns an error and ignores its arguments, so there is nothing to record or simulate. See docs/rfcs/0006-payments.md.";
var LOGIN_BEHAVIOR_IS_CONSTRUCTION_TIME = 'cannot be changed after boot in the TrUAPI test host: the host page reads it once at start. Pass `loginBehavior: "auto" | "manual"` to createTestHostFixture instead.';
var NO_PINNED_PRODUCT_ACCOUNT = "is not supported by the TrUAPI test host: a product account is DERIVED from (session root, product id), so it cannot be mapped to a chosen dev account. `@parity/host-api-test-sdk` could pin one because it reimplements the protocol with no core behind it. Read the address back from the host instead of pinning it, and expect `switchAccount` to change it: the next call derives from the new session root, with no reconnect needed. That is the real behaviour, not a test-host limitation.";
var NO_DERIVATION_URI = "is not supported by the TrUAPI test host: a session activates from 32 bytes of BIP-39 entropy, not a `//Alice`-style derivation path, so the addresses differ from polkadot-js's by construction. Use a built-in name (alice, bob, charlie, dave) or pass explicit entropy.";
function splitChainId(id) {
  const suffixes = [
    ["-asset-hub", "AssetHub", "assetHub"],
    ["-people", "People", "people"],
    ["-bulletin", "Bulletin", "bulletin"]
  ];
  for (const [suffix, identifier, configKey] of suffixes) {
    if (id.endsWith(suffix)) {
      return { network: id.slice(0, -suffix.length), identifier, configKey };
    }
  }
  return { network: id, identifier: "Relay" };
}
function fromNetworks(networks, loopbackStatements = false) {
  const runtimeConfig = {};
  const chains = [];
  let network = "paseo";
  for (const entry of networks) {
    const split = splitChainId(entry.id);
    network = split.network || network;
    chains.push({
      identifier: split.identifier,
      genesisHash: entry.genesisHash
    });
    if (split.configKey) {
      runtimeConfig[split.configKey] = { genesisHash: entry.genesisHash };
    }
  }
  return {
    mock: {
      chainProxies: networks.map((entry) => ({
        ...networks.length > 1 ? { genesisHash: entry.genesisHash } : {},
        rpcUrl: entry.rpcUrl,
        // Only the People chain carries the statement store, so serving it
        // locally on the hub as well would claim a store where none exists.
        ...loopbackStatements && splitChainId(entry.id).identifier === "People" ? { loopbackStatements: true } : {}
      })),
      supportedChains: { network, chains }
    },
    runtimeConfig
  };
}
function accountNames(accounts) {
  return accounts.map((account) => {
    if (typeof account === "string")
      return account;
    if (account.uri !== void 0) {
      throw new Error(`testHost account "${account.name}": \`uri\` ${NO_DERIVATION_URI}`);
    }
    if (account.entropy !== void 0) {
      if (account.entropy.length !== 32) {
        throw new Error(`testHost account "${account.name}": entropy must be 32 bytes, got ${account.entropy.length}`);
      }
      return { name: account.name, entropy: account.entropy };
    }
    return account.name;
  });
}
function createTestHostFixture(defaults) {
  if (defaults.productAccounts) {
    throw new Error(`testHost \`productAccounts\` ${NO_PINNED_PRODUCT_ACCOUNT}`);
  }
  const accounts = defaults.accounts ? accountNames(defaults.accounts) : void 0;
  let ownServer;
  const hostBase = async () => {
    if (defaults.hostUrl)
      return defaults.hostUrl;
    ownServer ??= createTestHostServer({ unref: true });
    return (await ownServer).url;
  };
  if (defaults.chain && defaults.networks) {
    throw new Error("testHost fixture: pass either `chain` (one chain, the older `@parity/host-api-test-sdk` spelling) or `networks` (several), not both -- `chain: x` is exactly `networks: [x]`.");
  }
  const chains = defaults.networks ?? (defaults.chain ? [defaults.chain] : void 0);
  const loopbackStatements = defaults.loopbackStatements ?? (defaults.allowances ?? "granted") === "granted";
  const expanded = chains ? fromNetworks(chains, loopbackStatements) : void 0;
  const mock = expanded ? { ...expanded.mock, ...defaults.mock } : defaults.mock;
  const runtimeConfig = expanded ? { ...expanded.runtimeConfig, ...defaults.runtimeConfig } : defaults.runtimeConfig;
  return {
    testHost: async ({ page }, use) => {
      const url = hostPageUrl(await hostBase(), {
        productUrl: defaults.productUrl,
        productId: defaults.productId,
        mock,
        runtimeConfig,
        accounts,
        loginBehavior: defaults.loginBehavior,
        topology: defaults.topology,
        allowances: defaults.allowances,
        logLevel: defaults.logLevel
      });
      await page.goto(url);
      await page.waitForFunction(() => !!window.__TRUAPI_TEST_HOST__, {
        timeout: defaults.readyTimeoutMs ?? 3e4
      });
      const call = (method, ...args) => page.evaluate(([name, callArgs]) => {
        const host = window.__TRUAPI_TEST_HOST__;
        if (!host)
          throw new Error("test host is not running on this page");
        const fn = host[name];
        if (typeof fn !== "function") {
          throw new Error(`test host has no control method ${name}`);
        }
        return fn.apply(host, callArgs);
      }, [method, args]);
      const testHost = {
        page,
        productFrame: () => page.frameLocator(PRODUCT_FRAME),
        getNavigationLog: () => call("getNavigationLog"),
        clearNavigationLog: () => call("clearNavigationLog"),
        getNotificationLog: () => call("getNotificationLog"),
        clearNotificationLog: () => call("clearNotificationLog"),
        getSigningLog: () => call("getSigningLog"),
        clearSigningLog: () => call("clearSigningLog"),
        getPermissionLog: () => call("getPermissionLog"),
        clearPermissionLog: () => call("clearPermissionLog"),
        getGrantedPermissions: () => call("getGrantedPermissions"),
        grantPermission: (permission) => call("grantPermission", permission),
        revokePermission: (permission) => call("revokePermission", permission),
        setEnforcePermissions: (enforce) => call("setEnforcePermissions", enforce),
        setPermissionBehavior: (behavior) => call("setPermissionBehavior", behavior),
        getChatRooms: () => call("getChatRooms"),
        getChatBots: () => call("getChatBots"),
        getChatMessageLog: () => call("getChatMessageLog"),
        clearChatState: () => call("clearChatState"),
        // `page.evaluate` serialises a Uint8Array as a plain index object, so
        // binary values are converted to arrays in the page and rebuilt here.
        // Without this a caller gets `{0: 114, …}` and any decode of it
        // silently yields "".
        getProductStorage: async () => {
          const raw = await page.evaluate(() => {
            const host = window.__TRUAPI_TEST_HOST__;
            if (!host)
              throw new Error("test host is not running on this page");
            return Object.fromEntries(Object.entries(host.getProductStorage()).map(([key, value]) => [
              key,
              Array.from(value)
            ]));
          });
          return Object.fromEntries(Object.entries(raw).map(([key, value]) => [
            key,
            Uint8Array.from(value)
          ]));
        },
        async findProductStorage(key) {
          const stored = await testHost.getProductStorage();
          const match = Object.entries(stored).find(([stored2]) => stored2.endsWith(`:${key}`));
          return match?.[1];
        },
        getPreimages: async () => {
          const raw = await page.evaluate(() => {
            const host = window.__TRUAPI_TEST_HOST__;
            if (!host)
              throw new Error("test host is not running on this page");
            return host.getPreimages().map((value) => Array.from(value));
          });
          return raw.map((value) => Uint8Array.from(value));
        },
        seedPreimage: (value) => call("seedPreimage", value),
        clearPreimages: () => call("clearPreimages"),
        getTheme: () => call("getTheme"),
        setTheme: (variant) => call("setTheme", variant),
        getIsAuthenticated: () => call("getIsAuthenticated"),
        getChainStatus: () => call("getChainStatus"),
        getConnectionStatus: () => call("getConnectionStatus"),
        getSentRpc: () => call("sentRpc"),
        clearSentRpc: () => call("clearSentRpc"),
        simulateDisconnect: () => call("simulateDisconnect"),
        simulateReconnect: () => call("simulateReconnect"),
        async waitForConnection(timeoutMs = 3e4) {
          await page.waitForFunction(() => (window.__TRUAPI_TEST_HOST__?.getHostCallCount() ?? 0) > 0, { timeout: timeoutMs });
        },
        getAccounts: () => call("getAccounts"),
        getActiveAccount: () => call("getActiveAccount"),
        // Switching account re-activates the session, which reloads the
        // product iframe; wait for it so the next action does not race it.
        switchAccount: async (name) => {
          await call("switchAccount", name);
          await page.frameLocator(PRODUCT_FRAME).locator("body").waitFor({ state: "attached" });
        },
        setAccounts: async (names) => {
          await call("setAccounts", names);
          await page.frameLocator(PRODUCT_FRAME).locator("body").waitFor({ state: "attached" });
        },
        signOut: () => call("signOut"),
        reset: () => call("reset"),
        // Sent as hex, not bytes: `page.evaluate` serialises a Uint8Array as a
        // plain index object, which would inject a statement of nothing.
        injectStatement: (statement) => page.evaluate((value) => {
          const host = window.__TRUAPI_TEST_HOST__;
          if (!host)
            throw new Error("test host is not running on this page");
          return host.injectStatement(value);
        }, typeof statement === "string" ? statement : `0x${Array.from(statement, (b) => b.toString(16).padStart(2, "0")).join("")}`),
        getInjectedStatements: () => call("getInjectedStatements"),
        clearStatements: () => call("clearStatements"),
        getSubmittedStatements: () => call("getSubmittedStatements"),
        // Playwright closes the page after the fixture yields, so there is
        // genuinely nothing to do -- not a silent stub standing in for work.
        dispose: () => Promise.resolve(),
        setPaymentBalance: () => {
          throw new Error(`testHost.setPaymentBalance ${NO_PAYMENT_SEAM}`);
        },
        getPaymentLog: () => {
          throw new Error(`testHost.getPaymentLog ${NO_PAYMENT_SEAM}`);
        },
        clearPaymentLog: () => {
          throw new Error(`testHost.clearPaymentLog ${NO_PAYMENT_SEAM}`);
        },
        setPaymentTopUpBehavior: () => {
          throw new Error(`testHost.setPaymentTopUpBehavior ${NO_PAYMENT_SEAM}`);
        },
        simulatePaymentStatus: () => {
          throw new Error(`testHost.simulatePaymentStatus ${NO_PAYMENT_SEAM}`);
        },
        injectChatAction: (action) => page.evaluate((value) => {
          const host = window.__TRUAPI_TEST_HOST__;
          if (!host)
            throw new Error("test host is not running on this page");
          return host.injectChatAction(value);
        }, action),
        setLoginBehavior: () => {
          throw new Error(`testHost.setLoginBehavior ${LOGIN_BEHAVIOR_IS_CONSTRUCTION_TIME}`);
        }
      };
      await use(testHost);
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_CHAIN,
  DEV_ACCOUNTS,
  DEV_ACCOUNT_NAMES,
  LIVE_CHAINS,
  PASEO_ASSET_HUB,
  createTestHostFixture,
  fromNetworks,
  liveChain
});
