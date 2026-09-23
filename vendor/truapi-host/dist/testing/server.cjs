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

// dist/testing/server.js
var server_exports = {};
__export(server_exports, {
  createTestHostServer: () => createTestHostServer
});
module.exports = __toCommonJS(server_exports);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createTestHostServer
});
