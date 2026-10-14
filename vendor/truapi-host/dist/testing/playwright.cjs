const __esm_import_meta_url = require('url').pathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
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

// ../../../node_modules/neverthrow/dist/index.cjs.js
var require_index_cjs = __commonJS({
  "../../../node_modules/neverthrow/dist/index.cjs.js"(exports2) {
    "use strict";
    var defaultErrorConfig = {
      withStackTrace: false
    };
    var createNeverThrowError = (message, result, config = defaultErrorConfig) => {
      const data = result.isOk() ? { type: "Ok", value: result.value } : { type: "Err", value: result.error };
      const maybeStack = config.withStackTrace ? new Error().stack : void 0;
      return {
        data,
        message,
        stack: maybeStack
      };
    };
    function __awaiter(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    }
    function __values(o) {
      var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
      if (m) return m.call(o);
      if (o && typeof o.length === "number") return {
        next: function() {
          if (o && i >= o.length) o = void 0;
          return { value: o && o[i++], done: !o };
        }
      };
      throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
    }
    function __await(v) {
      return this instanceof __await ? (this.v = v, this) : new __await(v);
    }
    function __asyncGenerator(thisArg, _arguments, generator) {
      if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
      var g = generator.apply(thisArg, _arguments || []), i, q = [];
      return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function() {
        return this;
      }, i;
      function awaitReturn(f) {
        return function(v) {
          return Promise.resolve(v).then(f, reject);
        };
      }
      function verb(n, f) {
        if (g[n]) {
          i[n] = function(v) {
            return new Promise(function(a, b) {
              q.push([n, v, a, b]) > 1 || resume(n, v);
            });
          };
          if (f) i[n] = f(i[n]);
        }
      }
      function resume(n, v) {
        try {
          step(g[n](v));
        } catch (e) {
          settle(q[0][3], e);
        }
      }
      function step(r) {
        r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
      }
      function fulfill(value) {
        resume("next", value);
      }
      function reject(value) {
        resume("throw", value);
      }
      function settle(f, v) {
        if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
      }
    }
    function __asyncDelegator(o) {
      var i, p;
      return i = {}, verb("next"), verb("throw", function(e) {
        throw e;
      }), verb("return"), i[Symbol.iterator] = function() {
        return this;
      }, i;
      function verb(n, f) {
        i[n] = o[n] ? function(v) {
          return (p = !p) ? { value: __await(o[n](v)), done: false } : f ? f(v) : v;
        } : f;
      }
    }
    function __asyncValues(o) {
      if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
      var m = o[Symbol.asyncIterator], i;
      return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
        return this;
      }, i);
      function verb(n) {
        i[n] = o[n] && function(v) {
          return new Promise(function(resolve2, reject) {
            v = o[n](v), settle(resolve2, reject, v.done, v.value);
          });
        };
      }
      function settle(resolve2, reject, d, v) {
        Promise.resolve(v).then(function(v2) {
          resolve2({ value: v2, done: d });
        }, reject);
      }
    }
    var ResultAsync = class _ResultAsync {
      constructor(res) {
        this._promise = res;
      }
      static fromSafePromise(promise) {
        const newPromise = promise.then((value) => new Ok(value));
        return new _ResultAsync(newPromise);
      }
      static fromPromise(promise, errorFn) {
        const newPromise = promise.then((value) => new Ok(value)).catch((e) => new Err(errorFn(e)));
        return new _ResultAsync(newPromise);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      static fromThrowable(fn, errorFn) {
        return (...args) => {
          return new _ResultAsync((() => __awaiter(this, void 0, void 0, function* () {
            try {
              return new Ok(yield fn(...args));
            } catch (error) {
              return new Err(errorFn ? errorFn(error) : error);
            }
          }))());
        };
      }
      static combine(asyncResultList) {
        return combineResultAsyncList(asyncResultList);
      }
      static combineWithAllErrors(asyncResultList) {
        return combineResultAsyncListWithAllErrors(asyncResultList);
      }
      map(f) {
        return new _ResultAsync(this._promise.then((res) => __awaiter(this, void 0, void 0, function* () {
          if (res.isErr()) {
            return new Err(res.error);
          }
          return new Ok(yield f(res.value));
        })));
      }
      andThrough(f) {
        return new _ResultAsync(this._promise.then((res) => __awaiter(this, void 0, void 0, function* () {
          if (res.isErr()) {
            return new Err(res.error);
          }
          const newRes = yield f(res.value);
          if (newRes.isErr()) {
            return new Err(newRes.error);
          }
          return new Ok(res.value);
        })));
      }
      andTee(f) {
        return new _ResultAsync(this._promise.then((res) => __awaiter(this, void 0, void 0, function* () {
          if (res.isErr()) {
            return new Err(res.error);
          }
          try {
            yield f(res.value);
          } catch (e) {
          }
          return new Ok(res.value);
        })));
      }
      orTee(f) {
        return new _ResultAsync(this._promise.then((res) => __awaiter(this, void 0, void 0, function* () {
          if (res.isOk()) {
            return new Ok(res.value);
          }
          try {
            yield f(res.error);
          } catch (e) {
          }
          return new Err(res.error);
        })));
      }
      mapErr(f) {
        return new _ResultAsync(this._promise.then((res) => __awaiter(this, void 0, void 0, function* () {
          if (res.isOk()) {
            return new Ok(res.value);
          }
          return new Err(yield f(res.error));
        })));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      andThen(f) {
        return new _ResultAsync(this._promise.then((res) => {
          if (res.isErr()) {
            return new Err(res.error);
          }
          const newValue = f(res.value);
          return newValue instanceof _ResultAsync ? newValue._promise : newValue;
        }));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      orElse(f) {
        return new _ResultAsync(this._promise.then((res) => __awaiter(this, void 0, void 0, function* () {
          if (res.isErr()) {
            return f(res.error);
          }
          return new Ok(res.value);
        })));
      }
      match(ok3, _err) {
        return this._promise.then((res) => res.match(ok3, _err));
      }
      unwrapOr(t) {
        return this._promise.then((res) => res.unwrapOr(t));
      }
      /**
       * @deprecated will be removed in 9.0.0.
       *
       * You can use `safeTry` without this method.
       * @example
       * ```typescript
       * safeTry(async function* () {
       *   const okValue = yield* yourResult
       * })
       * ```
       * Emulates Rust's `?` operator in `safeTry`'s body. See also `safeTry`.
       */
      safeUnwrap() {
        return __asyncGenerator(this, arguments, function* safeUnwrap_1() {
          return yield __await(yield __await(yield* __asyncDelegator(__asyncValues(yield __await(this._promise.then((res) => res.safeUnwrap()))))));
        });
      }
      // Makes ResultAsync implement PromiseLike<Result>
      then(successCallback, failureCallback) {
        return this._promise.then(successCallback, failureCallback);
      }
      [Symbol.asyncIterator]() {
        return __asyncGenerator(this, arguments, function* _a() {
          const result = yield __await(this._promise);
          if (result.isErr()) {
            yield yield __await(errAsync(result.error));
          }
          return yield __await(result.value);
        });
      }
    };
    function okAsync(value) {
      return new ResultAsync(Promise.resolve(new Ok(value)));
    }
    function errAsync(err3) {
      return new ResultAsync(Promise.resolve(new Err(err3)));
    }
    var fromPromise = ResultAsync.fromPromise;
    var fromSafePromise = ResultAsync.fromSafePromise;
    var fromAsyncThrowable = ResultAsync.fromThrowable;
    var combineResultList = (resultList) => {
      let acc = ok2([]);
      for (const result of resultList) {
        if (result.isErr()) {
          acc = err2(result.error);
          break;
        } else {
          acc.map((list) => list.push(result.value));
        }
      }
      return acc;
    };
    var combineResultAsyncList = (asyncResultList) => ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen(combineResultList);
    var combineResultListWithAllErrors = (resultList) => {
      let acc = ok2([]);
      for (const result of resultList) {
        if (result.isErr() && acc.isErr()) {
          acc.error.push(result.error);
        } else if (result.isErr() && acc.isOk()) {
          acc = err2([result.error]);
        } else if (result.isOk() && acc.isOk()) {
          acc.value.push(result.value);
        }
      }
      return acc;
    };
    var combineResultAsyncListWithAllErrors = (asyncResultList) => ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen(combineResultListWithAllErrors);
    exports2.Result = void 0;
    (function(Result) {
      function fromThrowable2(fn, errorFn) {
        return (...args) => {
          try {
            const result = fn(...args);
            return ok2(result);
          } catch (e) {
            return err2(errorFn ? errorFn(e) : e);
          }
        };
      }
      Result.fromThrowable = fromThrowable2;
      function combine(resultList) {
        return combineResultList(resultList);
      }
      Result.combine = combine;
      function combineWithAllErrors(resultList) {
        return combineResultListWithAllErrors(resultList);
      }
      Result.combineWithAllErrors = combineWithAllErrors;
    })(exports2.Result || (exports2.Result = {}));
    function ok2(value) {
      return new Ok(value);
    }
    function err2(err3) {
      return new Err(err3);
    }
    function safeTry(body) {
      const n = body().next();
      if (n instanceof Promise) {
        return new ResultAsync(n.then((r) => r.value));
      }
      return n.value;
    }
    var Ok = class {
      constructor(value) {
        this.value = value;
      }
      isOk() {
        return true;
      }
      isErr() {
        return !this.isOk();
      }
      map(f) {
        return ok2(f(this.value));
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      mapErr(_f) {
        return ok2(this.value);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      andThen(f) {
        return f(this.value);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      andThrough(f) {
        return f(this.value).map((_value) => this.value);
      }
      andTee(f) {
        try {
          f(this.value);
        } catch (e) {
        }
        return ok2(this.value);
      }
      orTee(_f) {
        return ok2(this.value);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      orElse(_f) {
        return ok2(this.value);
      }
      asyncAndThen(f) {
        return f(this.value);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      asyncAndThrough(f) {
        return f(this.value).map(() => this.value);
      }
      asyncMap(f) {
        return ResultAsync.fromSafePromise(f(this.value));
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      unwrapOr(_v) {
        return this.value;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      match(ok3, _err) {
        return ok3(this.value);
      }
      safeUnwrap() {
        const value = this.value;
        return (function* () {
          return value;
        })();
      }
      _unsafeUnwrap(_) {
        return this.value;
      }
      _unsafeUnwrapErr(config) {
        throw createNeverThrowError("Called `_unsafeUnwrapErr` on an Ok", this, config);
      }
      // eslint-disable-next-line @typescript-eslint/no-this-alias, require-yield
      *[Symbol.iterator]() {
        return this.value;
      }
    };
    var Err = class {
      constructor(error) {
        this.error = error;
      }
      isOk() {
        return false;
      }
      isErr() {
        return !this.isOk();
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      map(_f) {
        return err2(this.error);
      }
      mapErr(f) {
        return err2(f(this.error));
      }
      andThrough(_f) {
        return err2(this.error);
      }
      andTee(_f) {
        return err2(this.error);
      }
      orTee(f) {
        try {
          f(this.error);
        } catch (e) {
        }
        return err2(this.error);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      andThen(_f) {
        return err2(this.error);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      orElse(f) {
        return f(this.error);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      asyncAndThen(_f) {
        return errAsync(this.error);
      }
      asyncAndThrough(_f) {
        return errAsync(this.error);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      asyncMap(_f) {
        return errAsync(this.error);
      }
      unwrapOr(v) {
        return v;
      }
      match(_ok, err3) {
        return err3(this.error);
      }
      safeUnwrap() {
        const error = this.error;
        return (function* () {
          yield err2(error);
          throw new Error("Do not use this generator out of `safeTry`");
        })();
      }
      _unsafeUnwrap(config) {
        throw createNeverThrowError("Called `_unsafeUnwrap` on an Err", this, config);
      }
      _unsafeUnwrapErr(_) {
        return this.error;
      }
      *[Symbol.iterator]() {
        const self = this;
        yield self;
        return self;
      }
    };
    var fromThrowable = exports2.Result.fromThrowable;
    exports2.Err = Err;
    exports2.Ok = Ok;
    exports2.ResultAsync = ResultAsync;
    exports2.err = err2;
    exports2.errAsync = errAsync;
    exports2.fromAsyncThrowable = fromAsyncThrowable;
    exports2.fromPromise = fromPromise;
    exports2.fromSafePromise = fromSafePromise;
    exports2.fromThrowable = fromThrowable;
    exports2.ok = ok2;
    exports2.okAsync = okAsync;
    exports2.safeTry = safeTry;
  }
});

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
  liveChain: () => liveChain,
  productAccountAddress: () => productAccountAddress,
  productStorageEntry: () => productStorageEntry
});
module.exports = __toCommonJS(playwright_exports);

// dist/web/create-mock-host.js
var import_neverthrow = __toESM(require_index_cjs(), 1);
var import_truapi = require("@parity/truapi");
var CORE_PRODUCT_STORAGE_PREFIX = /^truapi:product-storage:v\d+:/;
function coreProductStorageKey(stored) {
  const prefix = CORE_PRODUCT_STORAGE_PREFIX.exec(stored);
  if (!prefix)
    return void 0;
  const rest = stored.slice(prefix[0].length);
  const separator = rest.indexOf(":");
  if (separator < 0)
    return void 0;
  const length = Number(rest.slice(0, separator));
  if (!Number.isInteger(length) || length < 0)
    return void 0;
  const afterId = rest.slice(separator + 1 + length);
  return afterId.startsWith(":") ? afterId.slice(1) : void 0;
}

// dist/testing/product-account.js
var import_promises = require("node:fs/promises");
var import_node_url2 = require("node:url");
var import_truapi2 = require("@parity/truapi");

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
function checkDerivationIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > 4294967295) {
    throw new RangeError(`product account index ${index} is not a u32: a derivation index is a whole number from 0 to 4294967295.`);
  }
  return index;
}

// dist/testing/require-wasm.js
var import_node_url = require("node:url");
function wasmArtifact(relativePath) {
  return (0, import_node_url.fileURLToPath)(new URL(`../../dist/wasm/${relativePath}`, __esm_import_meta_url));
}

// dist/testing/product-account.js
var loaded;
async function derivation() {
  loaded ??= (async () => {
    const glue = await import(
      // A file URL rather than a path: node refuses a Windows drive letter as
      // an ESM specifier.
      /* @vite-ignore */
      (0, import_node_url2.pathToFileURL)(wasmArtifact("testing/truapi_server.js")).href
    );
    await glue.default({
      module_or_path: await (0, import_promises.readFile)(wasmArtifact("testing/truapi_server_bg.wasm"))
    });
    return glue;
  })();
  return loaded;
}
async function productAccountAddress(query) {
  const { entropy } = resolveAccount(query.account);
  const index = import_truapi2.DerivationIndex.enc({
    tag: "Index",
    value: checkDerivationIndex(query.index ?? 0)
  });
  const core = await derivation();
  const subtree = core.deriveProductSubtreePublicKey(entropy, query.productId);
  return core.productAccountAddress(core.deriveProductAccountPublicKey(subtree, index));
}

// dist/testing/host-page.js
var import_truapi3 = require("@parity/truapi");
var PRODUCT_FRAME_ID = "product-frame";

// dist/testing/server.js
var import_node_http = require("node:http");
var import_promises2 = require("node:fs/promises");
var import_node_path = require("node:path");
var import_node_url3 = require("node:url");

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
  if (config.withheldResources?.length) {
    url.searchParams.set("withheld", config.withheldResources.join(","));
  }
  if (config.logLevel)
    url.searchParams.set("logLevel", config.logLevel);
  return url.toString();
}

// dist/testing/server.js
var __dirname = (0, import_node_path.dirname)((0, import_node_url3.fileURLToPath)(__esm_import_meta_url));
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
      server.close((err2) => err2 ? reject(err2) : done());
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
    const body = await (0, import_promises2.readFile)(target);
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
function productStorageEntry(stored, key) {
  const match = Object.entries(stored).find(([entry]) => (coreProductStorageKey(entry) ?? entry) === key);
  return match?.[1];
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
  const peopleChains = networks.filter((entry) => splitChainId(entry.id).identifier === "People");
  const carried = peopleChains.length > 0 || networks.length === 1;
  if (loopbackStatements === true && !carried) {
    throw new Error("testHost `loopbackStatements` needs a People chain in `networks`, or a single chain whose proxy takes every request. Several chains are declared and none is a People chain, so there is no proxy the statement store belongs on: the store would answer reads that the declared chains refuse. Add the People chain, or drop to one chain.");
  }
  const servesStatements = (entry) => loopbackStatements !== false && carried && (peopleChains.length > 0 ? splitChainId(entry.id).identifier === "People" : true);
  return {
    mock: {
      chainProxies: networks.map((entry) => ({
        ...networks.length > 1 ? { genesisHash: entry.genesisHash } : {},
        rpcUrl: entry.rpcUrl,
        ...servesStatements(entry) ? { loopbackStatements: true } : {}
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
  const loopbackStatements = defaults.loopbackStatements ?? ((defaults.allowances ?? "granted") === "granted" ? "default" : false);
  const withheldResources = Object.entries(defaults.behaviors?.resourceAllocation ?? {}).filter(([, allowed]) => !allowed).map(([resource]) => resource);
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
        withheldResources,
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
        getProductAccountAddress: (productId, index) => call("getProductAccountAddress", productId, index),
        findProductStorage: async (key) => productStorageEntry(await testHost.getProductStorage(), key),
        getProductStorageValue: async (key) => page.evaluate((storageKey) => {
          const host = window.__TRUAPI_TEST_HOST__;
          if (!host)
            throw new Error("test host is not running on this page");
          return host.getProductStorageValue(storageKey);
        }, key),
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
        injectStatement: (statement) => page.evaluate(
          (value) => {
            const host = window.__TRUAPI_TEST_HOST__;
            if (!host)
              throw new Error("test host is not running on this page");
            return host.injectStatement(value);
          },
          // A `Uint8Array` is reduced to hex here because `page.evaluate`
          // serialises it as a plain index object, which would inject a
          // statement of nothing. The decoded shape survives as it is.
          statement instanceof Uint8Array ? `0x${Array.from(statement, (byte) => byte.toString(16).padStart(2, "0")).join("")}` : statement
        ),
        getInjectedStatements: () => call("getInjectedStatements"),
        clearStatements: () => call("clearStatements"),
        getSubmittedStatements: () => call("getSubmittedStatements"),
        getStatements: () => call("getStatements"),
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
  liveChain,
  productAccountAddress,
  productStorageEntry
});
