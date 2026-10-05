const __esm_import_meta_url = require('url').pathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err2) => function __init() {
  if (err2) throw err2[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err2 = [e], e;
  }
};
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
        return value instanceof P ? value : new P(function(resolve) {
          resolve(value);
        });
      }
      return new (P || (P = Promise))(function(resolve, reject) {
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
          result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
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
          return new Promise(function(resolve, reject) {
            v = o[n](v), settle(resolve, reject, v.done, v.value);
          });
        };
      }
      function settle(resolve, reject, d, v) {
        Promise.resolve(v).then(function(v2) {
          resolve({ value: v2, done: d });
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

// dist/generated/host-callbacks.js
var S, import_truapi3, AccountAccessReview, AccountAliasReview, AuthState, ChatAuthorityReview, ContactSelection, CoreStorageKey, CreateProofReview, CreateTransactionReview, DevicePermissionStatus, HostChainEntry, HostChainSet, HostContactLookup, HostContactMatches, HostContactPick, HostContactsPick, IdentityDisclosureReview, LoginFailureKind, MainPurseChatPaymentReview, NativeChatFileExportRequest, NativeChatFilePickRequest, NativeChatPickedFile, NativeCoinageFailure, NativeCoinageMemo, NativeCoinageOperation, NativeCoinagePaymentIntent, NativeCoinageRequest, NativeCoinageResponse, NativeCoinageScope, NativeCoinageTopUpOutcome, PermissionAuthorizationRequest, PermissionAuthorizationStatus, PermissionDecision, PlacedAvatar, PlacedAvatars, PlacedContactLabel, PlacedContactLabels, PreimageSubmitReview, PresentedContactProfile, ProductContext, ProductExecutionKind, ProductSubtreeReview, ProfileDisclosureReview, ReceivingAuthority, ReceivingRegistration, ResourceAllocationReview, SessionUiInfo, SharedContactProfile, SignPayloadReview, SignRawReview, SignVrfReview, StatementStoreProductSignReview, UserConfirmationReview;
var init_host_callbacks = __esm({
  "dist/generated/host-callbacks.js"() {
    "use strict";
    S = __toESM(require("@parity/truapi/scale"), 1);
    import_truapi3 = require("@parity/truapi");
    AccountAccessReview = S.lazy(() => S.Struct({ requestingProductId: S.str, targetProductId: S.str }));
    AccountAliasReview = S.lazy(() => S.Struct({ callingProductId: S.str, context: import_truapi3.ProductProofContext, ringLocation: import_truapi3.RingLocation }));
    AuthState = S.lazy(() => S.TaggedUnion({ Disconnected: S._void, Pairing: S.Struct({ deeplink: S.str }), Connected: SessionUiInfo, LoginFailed: S.Struct({ kind: LoginFailureKind, reason: S.str }), Authenticating: S._void }));
    ChatAuthorityReview = S.lazy(() => S.Struct({ productId: S.str }));
    ContactSelection = S.lazy(() => S.Struct({ selected: S.Vector(import_truapi3.Bytes32) }));
    CoreStorageKey = S.lazy(() => S.TaggedUnion({ AuthSession: S._void, PairingDeviceIdentity: S._void, PermissionAuthorization: S.Struct({ productId: S.str, request: PermissionAuthorizationRequest }), AllowanceKeys: S.Struct({ sessionId: S.str }), LastProcessedPairingStatement: S._void, AutoSigningKey: S.Struct({ productId: S.str }), AutoSigningKeys: S._void, RingVrfRegistry: S.Struct({ rootPublicKey: S.Bytes(32) }), StatementRenewalTargets: S._void, DeviceEncryptionKey: S._void, ProductSubtree: S.Struct({ sessionId: S.str, productId: S.str }), SsoResponderRequestLedger: S.Struct({ rootPublicKey: S.Bytes(32), peerStatementAccountId: S.Bytes(32), peerEncryptionPublicKey: S.Bytes(32) }), ProductManifest: S.Struct({ productId: S.str }), MainPurseCoinage: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32) }), NativeChatDevice: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32), productId: S.str }), NativeChatFileChunk: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32), productId: S.str, attachmentId: S.Bytes(32), chunkIndex: S.u32 }), NativeChatProducts: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32) }), ProfileDisclosure: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32) }), ProfileReferencesReceived: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32), productId: S.str }), ProfilePersonalReferencesReceived: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32) }), NotificationReceiving: S._void }));
    CreateProofReview = S.lazy(() => S.Struct({ callingProductId: S.str, context: import_truapi3.ProductProofContext, ringLocation: import_truapi3.RingLocation, message: S.Bytes() }));
    CreateTransactionReview = S.lazy(() => S.TaggedUnion({ Product: S.Struct({ callingProductId: S.Option(S.str), payload: import_truapi3.ProductAccountTxPayload }), LegacyAccount: import_truapi3.LegacyAccountTxPayload }));
    DevicePermissionStatus = S.lazy(() => S.Status("Granted", "Denied", "NotDetermined", "NotApplicable"));
    HostChainEntry = S.lazy(() => S.Struct({ identifier: import_truapi3.ChainIdentifier, genesisHash: import_truapi3.Bytes32 }));
    HostChainSet = S.lazy(() => S.Struct({ network: S.str, chains: S.Vector(HostChainEntry) }));
    HostContactLookup = S.lazy(() => S.Struct({ handleKey: import_truapi3.Bytes32, handles: S.Vector(import_truapi3.Bytes32) }));
    HostContactMatches = S.lazy(() => S.Struct({ accounts: S.Vector(S.Option(import_truapi3.Bytes32)) }));
    HostContactPick = S.lazy(() => S.TaggedUnion({ Picked: S.Struct({ account: import_truapi3.Bytes32 }), Dismissed: S._void, NoContacts: S._void, Unsupported: S._void }));
    HostContactsPick = S.lazy(() => S.TaggedUnion({ Picked: S.Struct({ accounts: S.Vector(import_truapi3.Bytes32) }), Dismissed: S._void, NoContacts: S._void, Unsupported: S._void }));
    IdentityDisclosureReview = S.lazy(() => S.Struct({ productId: S.str }));
    LoginFailureKind = S.lazy(() => S.Status("NoFreeAllowanceSlots", "Other"));
    MainPurseChatPaymentReview = S.lazy(() => S.Struct({ callingProductId: S.str, recipientIdentity: S.Bytes(32), recipientUsername: S.Option(S.str), amountCents: S.u64, maxDebitCents: S.u64, genesisHash: S.Bytes(32), coinageInstanceId: S.Option(S.u32), operationId: S.Bytes(32) }));
    NativeChatFileExportRequest = S.lazy(() => S.Struct({ productId: S.str, peerIdentity: S.Bytes(32), peerUsername: S.Option(S.str), metadata: import_truapi3.HostNativeChatAttachmentMetadata }));
    NativeChatFilePickRequest = S.lazy(() => S.Struct({ productId: S.str, peerIdentity: S.Bytes(32), peerUsername: S.Option(S.str), maxFiles: S.u32 }));
    NativeChatPickedFile = S.lazy(() => S.Struct({ sourceId: S.str, metadata: import_truapi3.HostNativeChatAttachmentMetadata }));
    NativeCoinageFailure = S.lazy(() => S.Status("Unavailable", "InvalidRequest", "InvalidSource", "OperationConflict", "OperationNotFound", "InsufficientBalance", "UserRejected"));
    NativeCoinageMemo = S.lazy(() => S.Struct({ secretKeys: S.Vector(S.Bytes()), totalValueRaw: S.str }));
    NativeCoinageOperation = S.lazy(() => S.TaggedUnion({ Denomination: S._void, PreparePayment: S.Struct({ intent: NativeCoinagePaymentIntent }), CommitHandoff: S.Struct({ productId: S.str, operationId: S.Bytes(32) }), Views: S.Struct({ productId: S.str }), PendingHandoffs: S.Struct({ productId: S.str, acceptedOperations: S.Vector(S.Bytes(32)) }), ReadHandoff: S.Struct({ productId: S.str, operationId: S.Bytes(32) }), NoteDelivery: S.Struct({ productId: S.str, operationId: S.Bytes(32) }), Reconcile: S._void, TopUp: S.Struct({ productId: S.str, operationId: S.Bytes(32), minimumAmountRaw: S.str, secretKeys: S.Vector(S.Bytes()) }) }));
    NativeCoinagePaymentIntent = S.lazy(() => S.Struct({ operationId: S.Bytes(32), productId: S.str, requestId: S.str, peerIdentity: S.Bytes(32), recipientUsername: S.Option(S.str), amountCents: S.u64 }));
    NativeCoinageRequest = S.lazy(() => S.Struct({ scope: NativeCoinageScope, operation: NativeCoinageOperation }));
    NativeCoinageResponse = S.lazy(() => S.TaggedUnion({ Denomination: S.Struct({ centsUnitRaw: S.str }), Prepared: S.Struct({ payment: import_truapi3.HostNativeChatPayment, memo: S.Option(NativeCoinageMemo) }), Payments: S.Struct({ payments: S.Vector(import_truapi3.HostNativeChatPayment) }), TopUp: S.Struct({ outcome: NativeCoinageTopUpOutcome }), Done: S._void, Failed: S.Struct({ reason: NativeCoinageFailure }) }));
    NativeCoinageScope = S.lazy(() => S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32), coinageInstanceId: S.Option(S.u32) }));
    NativeCoinageTopUpOutcome = S.lazy(() => S.TaggedUnion({ Cleared: S._void, Partial: S.Struct({ creditedAmountRaw: S.str }), Pending: S._void, NotClaimed: S._void }));
    PermissionAuthorizationRequest = S.lazy(() => S.TaggedUnion({ Device: import_truapi3.HostDevicePermissionRequest, Remote: import_truapi3.RemotePermissionRequest, IdentityDisclosure: S._void, AccountAccess: S.Struct({ targetProductId: S.str }), ChatAuthority: S._void, StatementStoreAllowance: S.Struct({ derivationIndex: S.Option(import_truapi3.DerivationIndex) }), ProfileDisclosure: S._void }));
    PermissionAuthorizationStatus = S.lazy(() => S.Status("NotDetermined", "Denied", "Authorized"));
    PermissionDecision = S.lazy(() => S.Status("AllowOnce", "AllowAlways", "Deny"));
    PlacedAvatar = S.lazy(() => S.Struct({ slot: S.u32, rect: import_truapi3.AvatarRect, clip: import_truapi3.AvatarRect, reference: S.str, sharedAt: S.u64 }));
    PlacedAvatars = S.lazy(() => S.Struct({ surfaceWidth: S.u32, surfaceHeight: S.u32, avatars: S.Vector(PlacedAvatar) }));
    PlacedContactLabel = S.lazy(() => S.Struct({ slot: S.u32, account: import_truapi3.Bytes32, rect: import_truapi3.AvatarRect, clip: import_truapi3.AvatarRect }));
    PlacedContactLabels = S.lazy(() => S.Struct({ surfaceWidth: S.u32, surfaceHeight: S.u32, labels: S.Vector(PlacedContactLabel) }));
    PreimageSubmitReview = S.lazy(() => S.Struct({ size: S.u64 }));
    PresentedContactProfile = S.lazy(() => S.Struct({ shared: S.Option(SharedContactProfile), peerIdentity: S.Bytes(32), username: S.Option(S.str) }));
    ProductContext = S.lazy(() => S.Struct({ productId: S.str, executionKind: ProductExecutionKind }));
    ProductExecutionKind = S.lazy(() => S.Status("App", "Widget", "Worker"));
    ProductSubtreeReview = S.lazy(() => S.Struct({ productId: S.str }));
    ProfileDisclosureReview = S.lazy(() => S.Struct({ productId: S.str }));
    ReceivingAuthority = S.lazy(() => S.Struct({ productId: S.str, account: S.str, environment: S.str, artifact: S.str, genesis: S.str, generation: S.u64, osPermission: S.bool, transportReady: S.bool }));
    ReceivingRegistration = S.lazy(() => S.Struct({ authority: ReceivingAuthority, revision: S.u64, enabled: S.bool, watches: S.Vector(import_truapi3.ReceivingWatch), syncPending: S.bool }));
    ResourceAllocationReview = S.lazy(() => S.Struct({ callingProductId: S.str, resources: S.Vector(import_truapi3.AllocatableResource) }));
    SessionUiInfo = S.lazy(() => S.Struct({ publicKey: import_truapi3.Bytes32, identityAccountId: S.Option(import_truapi3.Bytes32), chatPublicKey: S.Option(import_truapi3.Bytes32), deviceEncPublicKey: S.Option(import_truapi3.Bytes32), peerStatementAccountId: S.Option(import_truapi3.Bytes32), deviceStatementAccountId: S.Option(import_truapi3.Bytes32), liteUsername: S.Option(S.str), fullUsername: S.Option(S.str) }));
    SharedContactProfile = S.lazy(() => S.Struct({ reference: S.str, sharedAt: S.u64 }));
    SignPayloadReview = S.lazy(() => S.TaggedUnion({ Product: S.Struct({ callingProductId: S.Option(S.str), request: import_truapi3.HostSignPayloadRequest }), LegacyAccount: import_truapi3.HostSignPayloadWithLegacyAccountRequest }));
    SignRawReview = S.lazy(() => S.TaggedUnion({ Product: S.Struct({ callingProductId: S.Option(S.str), request: import_truapi3.HostSignRawRequest, watermarked: S.bool }), LegacyAccount: S.Struct({ request: import_truapi3.HostSignRawWithLegacyAccountRequest, watermarked: S.bool }) }));
    SignVrfReview = S.lazy(() => S.Struct({ callingProductId: S.str, request: import_truapi3.HostAccountSignVrfRequest }));
    StatementStoreProductSignReview = S.lazy(() => S.Struct({ callingProductId: S.Option(S.str), account: import_truapi3.ProductAccountId, payload: S.Bytes() }));
    UserConfirmationReview = S.lazy(() => S.TaggedUnion({ SignPayload: SignPayloadReview, SignRaw: SignRawReview, StatementStoreProductSign: StatementStoreProductSignReview, CreateTransaction: CreateTransactionReview, AccountAlias: AccountAliasReview, CreateProof: CreateProofReview, IdentityDisclosure: IdentityDisclosureReview, ResourceAllocation: ResourceAllocationReview, PreimageSubmit: PreimageSubmitReview, AccountAccess: AccountAccessReview, SignVrf: SignVrfReview, ProductSubtree: ProductSubtreeReview, ChatAuthority: ChatAuthorityReview, MainPurseChatPayment: MainPurseChatPaymentReview, ProfileDisclosure: ProfileDisclosureReview }));
  }
});

// dist/error.js
function errorMessage(err2) {
  if (err2 instanceof Error)
    return err2.message;
  if (typeof err2 === "string")
    return err2;
  return JSON.stringify(err2) ?? String(err2);
}
var init_error = __esm({
  "dist/error.js"() {
    "use strict";
  }
});

// dist/adapter-support.js
function contactsHostAdapter(host) {
  if (host === void 0)
    return void 0;
  return {
    contacts: (lookup) => host.contacts(lookup),
    pickContact: (product) => host.pickContact?.(product) ?? Promise.resolve({ tag: "Unsupported" }),
    pickContacts: (product, selection) => host.pickContacts?.(product, selection) ?? Promise.resolve({ tag: "Unsupported" }),
    placeContactLabels: (product, placed) => host.placeContactLabels?.(product, placed) ?? Promise.resolve(false)
  };
}
function unwrapStreamResult(item) {
  if ("success" in item) {
    if (item.success === false) {
      throw new Error(item.value.reason);
    }
    return item.value;
  }
  if (item.isErr()) {
    throw new Error(item.error.reason);
  }
  return item.value;
}
function toAsyncIterator(stream) {
  const asyncIterable = stream;
  if (typeof asyncIterable[Symbol.asyncIterator] === "function") {
    return asyncIterable[Symbol.asyncIterator]();
  }
  const iterator = stream[Symbol.iterator]();
  const asyncIterator = {
    next: async () => iterator.next()
  };
  if (iterator.return) {
    asyncIterator.return = async () => iterator.return();
  }
  return asyncIterator;
}
function pumpIterator(iterator, onItem, label, onError, onComplete) {
  let stopped = false;
  void (async () => {
    try {
      while (!stopped) {
        const next = await iterator.next();
        if (stopped || next.done)
          return;
        onItem(next.value);
      }
    } catch (err2) {
      if (!stopped) {
        console.error(`[truapi host callbacks] ${label} failed`);
        onError?.({ reason: errorMessage(err2) });
      }
    } finally {
      if (!stopped)
        onComplete?.();
    }
  })();
  return () => {
    if (stopped)
      return;
    stopped = true;
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {
        console.error(`[truapi host callbacks] ${label} cleanup failed`);
      });
    } catch {
      console.error(`[truapi host callbacks] ${label} cleanup failed`);
    }
  };
}
function driveResultStream(stream, sendItem, sendError) {
  return pumpIterator(toAsyncIterator(stream), (value) => sendItem(unwrapStreamResult(value)), "subscription", sendError);
}
function chainConnectAdapter(host) {
  return async (genesisHash, onResponse, onClosed) => rpcConnectionAdapter(await host.connect((0, import_scale.hexToBytes)(genesisHash)), onResponse, onClosed);
}
function coinageWalletHostAdapter(host) {
  if (host === void 0)
    return void 0;
  let nativeCoinage;
  try {
    nativeCoinage = host.nativeCoinage.bind(host);
  } catch {
    throw new Error("Native Coinage wallet callback is unavailable");
  }
  return {
    async nativeCoinage(request) {
      try {
        return await nativeCoinage(request);
      } catch {
        throw new Error("Native Coinage wallet operation failed");
      }
    }
  };
}
function profileHostAdapter(host) {
  if (host === void 0 || typeof host.presentContactProfile === "function")
    return host;
  return {
    presentProfile: (product, request) => host.presentProfile(product, request),
    presentContactProfile: (product, presented) => {
      if (presented.shared === void 0)
        return Promise.reject(new Error("Contact profile feedback is unavailable"));
      return host.presentProfile(product, {
        reference: presented.shared.reference
      });
    },
    placeContactAvatars: (product, placed) => host.placeContactAvatars(product, placed)
  };
}
function hopConnectAdapter(host) {
  return async (genesisHash, endpoint, onResponse, onClosed) => {
    const genesis = (0, import_scale.hexToBytes)(genesisHash);
    const allowed = await host.allowedHopEndpoints(genesis);
    if (!allowed.includes(endpoint) || !endpoint.startsWith("wss://") || /[\s\u0000-\u001f\u007f-\u009f#\\]/u.test(endpoint) || endpoint.slice(6).split(/[/?]/u, 1)[0].includes("@")) {
      throw new Error("HOP endpoint is not an allowed secure WebSocket URL");
    }
    const url = new URL(endpoint);
    if (!url.hostname || url.username || url.password || url.hash) {
      throw new Error("HOP endpoint is not an allowed secure WebSocket URL");
    }
    return rpcConnectionAdapter(await host.connectHop(genesis, endpoint), onResponse, onClosed);
  };
}
function rpcConnectionAdapter(connection, onResponse, onClosed) {
  let closed = false;
  let stopResponses;
  const close = (notify) => {
    if (closed)
      return;
    closed = true;
    stopResponses?.();
    try {
      connection.close();
    } finally {
      if (notify)
        onClosed?.();
    }
  };
  try {
    stopResponses = pumpIterator(connection.responses()[Symbol.asyncIterator](), onResponse, "JSON-RPC responses", void 0, () => {
      try {
        close(true);
      } catch {
        console.error("[truapi host callbacks] JSON-RPC close failed");
      }
    });
    if (closed)
      stopResponses();
  } catch (err2) {
    close(false);
    throw err2;
  }
  return {
    send(request) {
      if (closed)
        throw new Error("JSON-RPC connection is closed");
      try {
        connection.send(request);
      } catch (err2) {
        close(true);
        throw err2;
      }
    },
    close: () => close(false)
  };
}
var import_scale, unavailableHopProvider, unavailableNativeChatFilesHost;
var init_adapter_support = __esm({
  "dist/adapter-support.js"() {
    "use strict";
    import_scale = require("@parity/truapi/scale");
    init_error();
    unavailableHopProvider = {
      async allowedHopEndpoints() {
        return [];
      },
      async connectHop() {
        throw new Error("HOP provider is unavailable");
      }
    };
    unavailableNativeChatFilesHost = {
      async pickChatFiles() {
        throw new Error("Native Chat files are unavailable");
      },
      async readChatFile() {
        throw new Error("Native Chat files are unavailable");
      },
      async releaseChatFile() {
        throw new Error("Native Chat files are unavailable");
      },
      async beginChatFileExport() {
        throw new Error("Native Chat files are unavailable");
      },
      async writeChatFileExport() {
        throw new Error("Native Chat files are unavailable");
      },
      async finishChatFileExport() {
        throw new Error("Native Chat files are unavailable");
      },
      async cancelChatFileExport() {
        throw new Error("Native Chat files are unavailable");
      }
    };
  }
});

// dist/generated/host-callbacks-adapter.js
var host_callbacks_adapter_exports = {};
__export(host_callbacks_adapter_exports, {
  createWasmRawCallbacks: () => createWasmRawCallbacks
});
function createWasmRawCallbacks(callbacks) {
  const chat = callbacks.chat;
  const coinageWallet = coinageWalletHostAdapter(callbacks.coinageWallet);
  const contacts = contactsHostAdapter(callbacks.contacts);
  const identityBackend = callbacks.identityBackend;
  const permissionStatus = callbacks.permissionStatus;
  const pocket = callbacks.pocket;
  const profile = profileHostAdapter(callbacks.profile);
  const hop = callbacks.hop ?? unavailableHopProvider;
  const nativeChatFiles = callbacks.nativeChatFiles ?? unavailableNativeChatFilesHost;
  return {
    authStateChanged: async (state) => await callbacks.auth.authStateChanged(AuthState.dec(state)),
    chainConnect: chainConnectAdapter(callbacks.chain),
    ...chat ? {
      createChatRoom: async (product, request) => import_truapi4.HostChatCreateRoomResponse.enc(await chat.createChatRoom(ProductContext.dec(product), import_truapi4.HostChatCreateRoomRequest.dec(request))),
      registerChatBot: async (product, request) => import_truapi4.HostChatRegisterBotResponse.enc(await chat.registerChatBot(ProductContext.dec(product), import_truapi4.HostChatRegisterBotRequest.dec(request))),
      postChatMessage: async (product, request) => import_truapi4.HostChatPostMessageResponse.enc(await chat.postChatMessage(ProductContext.dec(product), import_truapi4.HostChatPostMessageRequest.dec(request))),
      subscribeChatRooms: (product, sendItem, sendError) => driveResultStream(chat.subscribeChatRooms(ProductContext.dec(product)), (item) => sendItem(import_truapi4.HostChatListSubscribeItem.enc(item)), sendError)
    } : {},
    ...coinageWallet ? {
      nativeCoinage: async (request) => NativeCoinageResponse.enc(await coinageWallet.nativeCoinage(NativeCoinageRequest.dec(request)))
    } : {},
    ...contacts ? {
      contacts: async (lookup) => HostContactMatches.enc(await contacts.contacts(HostContactLookup.dec(lookup))),
      pickContact: async (product) => HostContactPick.enc(await contacts.pickContact(ProductContext.dec(product))),
      pickContacts: async (product, selection) => HostContactsPick.enc(await contacts.pickContacts(ProductContext.dec(product), ContactSelection.dec(selection))),
      placeContactLabels: async (product, placed) => await contacts.placeContactLabels(ProductContext.dec(product), PlacedContactLabels.dec(placed))
    } : {},
    readCoreStorage: async (key) => await callbacks.coreStorage.readCoreStorage(CoreStorageKey.dec(key)),
    writeCoreStorage: async (key, value) => await callbacks.coreStorage.writeCoreStorage(CoreStorageKey.dec(key), value),
    clearCoreStorage: async (key) => await callbacks.coreStorage.clearCoreStorage(CoreStorageKey.dec(key)),
    featureSupported: async (request) => import_truapi4.HostFeatureSupportedResponse.enc(await callbacks.features.featureSupported(import_truapi4.HostFeatureSupportedRequest.dec(request))),
    supportedChains: async () => HostChainSet.enc(await callbacks.features.supportedChains()),
    allowedHopEndpoints: async (bulletinGenesisHash) => allowedHopEndpointsResultCodec.enc(await hop.allowedHopEndpoints(bulletinGenesisHash)),
    hopConnect: hopConnectAdapter(hop),
    ...identityBackend ? {
      identityUsernameCandidates: async (username, peopleChainGenesisHash) => identityUsernameCandidatesResultCodec.enc(await identityBackend.identityUsernameCandidates(username, peopleChainGenesisHash))
    } : {},
    subscribeLocale: (sendItem, sendError) => driveResultStream(callbacks.locale.subscribeLocale(), (item) => sendItem(import_truapi4.HostLocaleSubscribeItem.enc(item)), sendError),
    localizeTimestamps: async (request) => import_truapi4.HostLocaleLocalizeTimestampsResponse.enc(await callbacks.locale.localizeTimestamps(import_truapi4.HostLocaleLocalizeTimestampsRequest.dec(request))),
    pickChatFiles: async (request) => pickChatFilesResultCodec.enc(await nativeChatFiles.pickChatFiles(NativeChatFilePickRequest.dec(request))),
    readChatFile: async (sourceId, offset, length) => await nativeChatFiles.readChatFile(sourceId, offset, length),
    releaseChatFile: async (sourceId) => await nativeChatFiles.releaseChatFile(sourceId),
    beginChatFileExport: async (request) => await nativeChatFiles.beginChatFileExport(NativeChatFileExportRequest.dec(request)),
    writeChatFileExport: async (exportId, offset, data) => await nativeChatFiles.writeChatFileExport(exportId, offset, data),
    finishChatFileExport: async (exportId) => await nativeChatFiles.finishChatFileExport(exportId),
    cancelChatFileExport: async (exportId) => await nativeChatFiles.cancelChatFileExport(exportId),
    navigateTo: async (url) => await callbacks.navigation.navigateTo(url),
    pushNotification: async (notification) => import_truapi4.HostPushNotificationResponse.enc(await callbacks.notifications.pushNotification(import_truapi4.HostPushNotificationRequest.dec(notification))),
    cancelNotification: async (id) => await callbacks.notifications.cancelNotification(id),
    receiverAuthority: async (productId) => {
      const value = await callbacks.notifications.receiverAuthority(productId);
      return value == null ? void 0 : ReceivingAuthority.enc(value);
    },
    receiverConsent: async (authority, watches) => await callbacks.notifications.receiverConsent(ReceivingAuthority.dec(authority), S2.Vector(import_truapi4.ReceivingWatch).dec(watches)),
    receiverChanged: async () => await callbacks.notifications.receiverChanged(),
    receiverCommand: async (productId, action, payload) => await callbacks.notifications.receiverCommand(productId, action, payload),
    activationEvents: async () => import_truapi4.NotificationActivations.enc(await callbacks.notifications.activationEvents()),
    acknowledgeActivation: async (request) => await callbacks.notifications.acknowledgeActivation(import_truapi4.NotificationActivationAcknowledgeRequest.dec(request)),
    ...permissionStatus ? {
      devicePermissionStatus: async (request) => DevicePermissionStatus.enc(await permissionStatus.devicePermissionStatus(import_truapi4.HostDevicePermissionRequest.dec(request)))
    } : {},
    devicePermission: async (product, request) => PermissionDecision.enc(await callbacks.permissions.devicePermission(ProductContext.dec(product), import_truapi4.HostDevicePermissionRequest.dec(request))),
    remotePermission: async (product, request) => PermissionDecision.enc(await callbacks.permissions.remotePermission(ProductContext.dec(product), import_truapi4.RemotePermissionRequest.dec(request))),
    ...pocket ? {
      subscribePocketCards: (product, sendItem, sendError) => driveResultStream(pocket.subscribePocketCards(ProductContext.dec(product)), (item) => sendItem(import_truapi4.HostPocketListSubscribeItem.enc(item)), sendError),
      removePocketCard: async (product, request) => await pocket.removePocketCard(ProductContext.dec(product), import_truapi4.HostPocketRemoveCardRequest.dec(request))
    } : {},
    lookupPreimage: (key, sendItem, sendError) => driveResultStream(callbacks.preimage.lookupPreimage(key), sendItem, sendError),
    beginOperation: async (product, label) => import_truapi4.HostWorkerBeginOperationResponse.enc(await callbacks.productOperations.beginOperation(ProductContext.dec(product), label)),
    endOperation: async (product, id) => await callbacks.productOperations.endOperation(ProductContext.dec(product), id),
    read: async (key) => await callbacks.productStorage.read(key),
    write: async (key, value) => await callbacks.productStorage.write(key, value),
    clear: async (key) => await callbacks.productStorage.clear(key),
    subscribeStorage: (key, sendItem, sendError) => driveResultStream(callbacks.productStorage.subscribeStorage(key), (item) => sendItem(import_truapi4.HostLocalStorageChangeItem.enc(item)), sendError),
    ...profile ? {
      presentProfile: async (product, request) => await profile.presentProfile(ProductContext.dec(product), import_truapi4.HostProfilePresentRequest.dec(request)),
      presentContactProfile: async (product, presented) => await profile.presentContactProfile(ProductContext.dec(product), PresentedContactProfile.dec(presented)),
      placeContactAvatars: async (product, placed) => await profile.placeContactAvatars(ProductContext.dec(product), PlacedAvatars.dec(placed))
    } : {},
    subscribeTheme: (sendItem, sendError) => driveResultStream(callbacks.theme.subscribeTheme(), (item) => sendItem(import_truapi4.HostThemeSubscribeItem.enc(item)), sendError),
    confirmPermission: async (review) => PermissionDecision.enc(await callbacks.userConfirmation.confirmPermission(UserConfirmationReview.dec(review))),
    confirmUserAction: async (review) => await callbacks.userConfirmation.confirmUserAction(UserConfirmationReview.dec(review))
  };
}
var S2, import_truapi4, allowedHopEndpointsResultCodec, identityUsernameCandidatesResultCodec, pickChatFilesResultCodec;
var init_host_callbacks_adapter = __esm({
  "dist/generated/host-callbacks-adapter.js"() {
    "use strict";
    S2 = __toESM(require("@parity/truapi/scale"), 1);
    import_truapi4 = require("@parity/truapi");
    init_host_callbacks();
    init_adapter_support();
    allowedHopEndpointsResultCodec = S2.Vector(S2.str);
    identityUsernameCandidatesResultCodec = S2.Vector(S2.Bytes(32));
    pickChatFilesResultCodec = S2.Vector(NativeChatPickedFile);
  }
});

// dist/testing/create-mock-client.js
var create_mock_client_exports = {};
__export(create_mock_client_exports, {
  createMockClient: () => createMockClient
});
module.exports = __toCommonJS(create_mock_client_exports);
var import_truapi5 = require("@parity/truapi");

// ../../../node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes2 = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes2 ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes2)
    throw new TypeError(message);
  throw new RangeError(message);
}
function copyBytes(bytes2) {
  return Uint8Array.from(abytes(bytes2));
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
var swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n) >>> 0;
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}

// ../../../node_modules/@noble/hashes/_blake.js
var BSIGMA = /* @__PURE__ */ Uint8Array.from([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  14,
  10,
  4,
  8,
  9,
  15,
  13,
  6,
  1,
  12,
  0,
  2,
  11,
  7,
  5,
  3,
  11,
  8,
  12,
  0,
  5,
  2,
  15,
  13,
  10,
  14,
  3,
  6,
  7,
  1,
  9,
  4,
  7,
  9,
  3,
  1,
  13,
  12,
  11,
  14,
  2,
  6,
  5,
  10,
  4,
  0,
  15,
  8,
  9,
  0,
  5,
  7,
  2,
  4,
  10,
  15,
  14,
  1,
  11,
  12,
  6,
  8,
  3,
  13,
  2,
  12,
  6,
  10,
  0,
  11,
  8,
  3,
  4,
  13,
  7,
  5,
  15,
  14,
  1,
  9,
  12,
  5,
  1,
  15,
  14,
  13,
  4,
  10,
  0,
  7,
  6,
  3,
  9,
  2,
  8,
  11,
  13,
  11,
  7,
  14,
  12,
  1,
  3,
  9,
  5,
  0,
  15,
  4,
  8,
  6,
  2,
  10,
  6,
  15,
  14,
  9,
  11,
  3,
  0,
  8,
  12,
  2,
  13,
  7,
  1,
  4,
  10,
  5,
  10,
  2,
  8,
  4,
  7,
  6,
  1,
  5,
  15,
  11,
  9,
  14,
  3,
  12,
  13,
  0,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  14,
  10,
  4,
  8,
  9,
  15,
  13,
  6,
  1,
  12,
  0,
  2,
  11,
  7,
  5,
  3,
  // Blake1, unused in others
  11,
  8,
  12,
  0,
  5,
  2,
  15,
  13,
  10,
  14,
  3,
  6,
  7,
  1,
  9,
  4,
  7,
  9,
  3,
  1,
  13,
  12,
  11,
  14,
  2,
  6,
  5,
  10,
  4,
  0,
  15,
  8,
  9,
  0,
  5,
  7,
  2,
  4,
  10,
  15,
  14,
  1,
  11,
  12,
  6,
  8,
  3,
  13,
  2,
  12,
  6,
  10,
  0,
  11,
  8,
  3,
  4,
  13,
  7,
  5,
  15,
  14,
  1,
  9
]);

// ../../../node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
var rotr32H = (_h, l) => l;
var rotr32L = (h, _l) => h;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;

// ../../../node_modules/@noble/hashes/blake2.js
var B2B_IV = /* @__PURE__ */ Uint32Array.from([
  4089235720,
  1779033703,
  2227873595,
  3144134277,
  4271175723,
  1013904242,
  1595750129,
  2773480762,
  2917565137,
  1359893119,
  725511199,
  2600822924,
  4215389547,
  528734635,
  327033209,
  1541459225
]);
var BBUF = /* @__PURE__ */ new Uint32Array(32);
function G1b(a, b, c, d, msg, x) {
  const Xl = msg[x], Xh = msg[x + 1];
  let Al = BBUF[2 * a], Ah = BBUF[2 * a + 1];
  let Bl = BBUF[2 * b], Bh = BBUF[2 * b + 1];
  let Cl = BBUF[2 * c], Ch = BBUF[2 * c + 1];
  let Dl = BBUF[2 * d], Dh = BBUF[2 * d + 1];
  const ll = add3L(Al, Bl, Xl);
  Ah = add3H(ll, Ah, Bh, Xh);
  Al = ll | 0;
  let xh = Dh ^ Ah, xl = Dl ^ Al;
  Dh = rotr32H(xh, xl);
  Dl = rotr32L(xh, xl);
  ({ h: Ch, l: Cl } = add(Ch, Cl, Dh, Dl));
  xh = Bh ^ Ch;
  xl = Bl ^ Cl;
  Bh = rotrSH(xh, xl, 24);
  Bl = rotrSL(xh, xl, 24);
  BBUF[2 * a] = Al;
  BBUF[2 * a + 1] = Ah;
  BBUF[2 * b] = Bl;
  BBUF[2 * b + 1] = Bh;
  BBUF[2 * c] = Cl;
  BBUF[2 * c + 1] = Ch;
  BBUF[2 * d] = Dl;
  BBUF[2 * d + 1] = Dh;
}
function G2b(a, b, c, d, msg, x) {
  const Xl = msg[x], Xh = msg[x + 1];
  let Al = BBUF[2 * a], Ah = BBUF[2 * a + 1];
  let Bl = BBUF[2 * b], Bh = BBUF[2 * b + 1];
  let Cl = BBUF[2 * c], Ch = BBUF[2 * c + 1];
  let Dl = BBUF[2 * d], Dh = BBUF[2 * d + 1];
  const ll = add3L(Al, Bl, Xl);
  Ah = add3H(ll, Ah, Bh, Xh);
  Al = ll | 0;
  let xh = Dh ^ Ah, xl = Dl ^ Al;
  Dh = rotrSH(xh, xl, 16);
  Dl = rotrSL(xh, xl, 16);
  ({ h: Ch, l: Cl } = add(Ch, Cl, Dh, Dl));
  xh = Bh ^ Ch;
  xl = Bl ^ Cl;
  Bh = rotrBH(xh, xl, 63);
  Bl = rotrBL(xh, xl, 63);
  BBUF[2 * a] = Al;
  BBUF[2 * a + 1] = Ah;
  BBUF[2 * b] = Bl;
  BBUF[2 * b + 1] = Bh;
  BBUF[2 * c] = Cl;
  BBUF[2 * c + 1] = Ch;
  BBUF[2 * d] = Dl;
  BBUF[2 * d + 1] = Dh;
}
function checkBlake2Opts(outputLen, opts = {}, keyLen, saltLen, persLen) {
  anumber(keyLen);
  if (outputLen <= 0 || outputLen > keyLen)
    throw new Error('"dkLen" must be 1..' + keyLen + ", got " + outputLen);
  const { key, salt, personalization } = opts;
  if (key !== void 0 && (key.length < 1 || key.length > keyLen))
    throw new Error('"key" expected to be undefined or of length=1..' + keyLen);
  if (salt !== void 0)
    abytes(salt, saltLen, "salt");
  if (personalization !== void 0)
    abytes(personalization, persLen, "personalization");
}
var _BLAKE2 = class {
  buffer;
  buffer32;
  finished = false;
  destroyed = false;
  length = 0;
  pos = 0;
  blockLen;
  outputLen;
  canXOF = false;
  constructor(blockLen, outputLen) {
    anumber(blockLen);
    anumber(outputLen);
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.buffer = new Uint8Array(blockLen);
    this.buffer32 = u32(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { blockLen, buffer, buffer32 } = this;
    const len = data.length;
    const offset = data.byteOffset;
    const buf = data.buffer;
    for (let pos = 0; pos < len; ) {
      if (this.pos === blockLen) {
        swap32IfBE(buffer32);
        this.compress(buffer32, 0, false);
        swap32IfBE(buffer32);
        this.pos = 0;
      }
      const take = Math.min(blockLen - this.pos, len - pos);
      const dataOffset = offset + pos;
      if (take === blockLen && !(dataOffset % 4) && pos + take < len) {
        const data32 = new Uint32Array(buf, dataOffset, Math.floor((len - pos) / 4));
        swap32IfBE(data32);
        for (let pos32 = 0; pos + blockLen < len; pos32 += buffer32.length, pos += blockLen) {
          this.length += blockLen;
          this.compress(data32, pos32, false);
        }
        swap32IfBE(data32);
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      this.length += take;
      pos += take;
    }
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    if (out.byteOffset & 3)
      throw new RangeError('"output" expected 4-byte aligned byteOffset, got ' + out.byteOffset);
    const { pos, buffer32 } = this;
    this.finished = true;
    this.buffer.fill(0, pos);
    swap32IfBE(buffer32);
    this.compress(buffer32, 0, true);
    swap32IfBE(buffer32);
    const state = this.get();
    const out32 = out === this.buffer ? buffer32 : u32(out);
    const full = Math.floor(this.outputLen / 4);
    for (let i = 0; i < full; i++)
      out32[i] = swap8IfBE(state[i]);
    const tail = this.outputLen % 4;
    if (!tail)
      return;
    const off = full * 4;
    const word = state[full];
    for (let i = 0; i < tail; i++)
      out[off + i] = word >>> 8 * i;
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    const { buffer, length, finished, destroyed, outputLen, pos } = this;
    to ||= new this.constructor({ dkLen: outputLen });
    to.set(...this.get());
    to.buffer.set(buffer);
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    to.outputLen = outputLen;
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var _BLAKE2b = class extends _BLAKE2 {
  // Same IV words as SHA-512 / BLAKE2b, encoded as LE u32 low/high halves.
  v0l = B2B_IV[0] | 0;
  v0h = B2B_IV[1] | 0;
  v1l = B2B_IV[2] | 0;
  v1h = B2B_IV[3] | 0;
  v2l = B2B_IV[4] | 0;
  v2h = B2B_IV[5] | 0;
  v3l = B2B_IV[6] | 0;
  v3h = B2B_IV[7] | 0;
  v4l = B2B_IV[8] | 0;
  v4h = B2B_IV[9] | 0;
  v5l = B2B_IV[10] | 0;
  v5h = B2B_IV[11] | 0;
  v6l = B2B_IV[12] | 0;
  v6h = B2B_IV[13] | 0;
  v7l = B2B_IV[14] | 0;
  v7h = B2B_IV[15] | 0;
  constructor(opts = {}) {
    opts = checkOpts({}, opts);
    const olen = opts.dkLen === void 0 ? 64 : opts.dkLen;
    super(128, olen);
    checkBlake2Opts(olen, opts, 64, 16, 16);
    let { key, personalization, salt } = opts;
    let keyLength = 0;
    if (key !== void 0) {
      abytes(key, void 0, "key");
      keyLength = key.length;
    }
    this.v0l ^= this.outputLen | keyLength << 8 | 1 << 16 | 1 << 24;
    if (salt !== void 0) {
      abytes(salt, void 0, "salt");
      const slt = u32(copyBytes(salt));
      this.v4l ^= swap8IfBE(slt[0]);
      this.v4h ^= swap8IfBE(slt[1]);
      this.v5l ^= swap8IfBE(slt[2]);
      this.v5h ^= swap8IfBE(slt[3]);
    }
    if (personalization !== void 0) {
      abytes(personalization, void 0, "personalization");
      const pers = u32(copyBytes(personalization));
      this.v6l ^= swap8IfBE(pers[0]);
      this.v6h ^= swap8IfBE(pers[1]);
      this.v7l ^= swap8IfBE(pers[2]);
      this.v7h ^= swap8IfBE(pers[3]);
    }
    if (key !== void 0) {
      const tmp = new Uint8Array(this.blockLen);
      tmp.set(key);
      this.update(tmp);
      clean(tmp);
    }
  }
  // prettier-ignore
  get() {
    let { v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h } = this;
    return [v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h];
  }
  // prettier-ignore
  set(v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h) {
    this.v0l = v0l | 0;
    this.v0h = v0h | 0;
    this.v1l = v1l | 0;
    this.v1h = v1h | 0;
    this.v2l = v2l | 0;
    this.v2h = v2h | 0;
    this.v3l = v3l | 0;
    this.v3h = v3h | 0;
    this.v4l = v4l | 0;
    this.v4h = v4h | 0;
    this.v5l = v5l | 0;
    this.v5h = v5h | 0;
    this.v6l = v6l | 0;
    this.v6h = v6h | 0;
    this.v7l = v7l | 0;
    this.v7h = v7h | 0;
  }
  compress(msg, offset, isLast) {
    const { v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h } = this;
    {
      BBUF[0] = v0l;
      BBUF[1] = v0h;
      BBUF[2] = v1l;
      BBUF[3] = v1h;
      BBUF[4] = v2l;
      BBUF[5] = v2h;
      BBUF[6] = v3l;
      BBUF[7] = v3h;
      BBUF[8] = v4l;
      BBUF[9] = v4h;
      BBUF[10] = v5l;
      BBUF[11] = v5h;
      BBUF[12] = v6l;
      BBUF[13] = v6h;
      BBUF[14] = v7l;
      BBUF[15] = v7h;
    }
    BBUF.set(B2B_IV, 16);
    const l = fromNumL(this.length);
    const h = fromNumH(this.length);
    BBUF[24] = B2B_IV[8] ^ l;
    BBUF[25] = B2B_IV[9] ^ h;
    if (isLast) {
      BBUF[28] = ~BBUF[28];
      BBUF[29] = ~BBUF[29];
    }
    let j = 0;
    const s = BSIGMA;
    for (let i = 0; i < 12; i++) {
      G1b(0, 4, 8, 12, msg, offset + 2 * s[j++]);
      G2b(0, 4, 8, 12, msg, offset + 2 * s[j++]);
      G1b(1, 5, 9, 13, msg, offset + 2 * s[j++]);
      G2b(1, 5, 9, 13, msg, offset + 2 * s[j++]);
      G1b(2, 6, 10, 14, msg, offset + 2 * s[j++]);
      G2b(2, 6, 10, 14, msg, offset + 2 * s[j++]);
      G1b(3, 7, 11, 15, msg, offset + 2 * s[j++]);
      G2b(3, 7, 11, 15, msg, offset + 2 * s[j++]);
      G1b(0, 5, 10, 15, msg, offset + 2 * s[j++]);
      G2b(0, 5, 10, 15, msg, offset + 2 * s[j++]);
      G1b(1, 6, 11, 12, msg, offset + 2 * s[j++]);
      G2b(1, 6, 11, 12, msg, offset + 2 * s[j++]);
      G1b(2, 7, 8, 13, msg, offset + 2 * s[j++]);
      G2b(2, 7, 8, 13, msg, offset + 2 * s[j++]);
      G1b(3, 4, 9, 14, msg, offset + 2 * s[j++]);
      G2b(3, 4, 9, 14, msg, offset + 2 * s[j++]);
    }
    this.v0l ^= BBUF[0] ^ BBUF[16];
    this.v0h ^= BBUF[1] ^ BBUF[17];
    this.v1l ^= BBUF[2] ^ BBUF[18];
    this.v1h ^= BBUF[3] ^ BBUF[19];
    this.v2l ^= BBUF[4] ^ BBUF[20];
    this.v2h ^= BBUF[5] ^ BBUF[21];
    this.v3l ^= BBUF[6] ^ BBUF[22];
    this.v3h ^= BBUF[7] ^ BBUF[23];
    this.v4l ^= BBUF[8] ^ BBUF[24];
    this.v4h ^= BBUF[9] ^ BBUF[25];
    this.v5l ^= BBUF[10] ^ BBUF[26];
    this.v5h ^= BBUF[11] ^ BBUF[27];
    this.v6l ^= BBUF[12] ^ BBUF[28];
    this.v6h ^= BBUF[13] ^ BBUF[29];
    this.v7l ^= BBUF[14] ^ BBUF[30];
    this.v7h ^= BBUF[15] ^ BBUF[31];
    clean(BBUF);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer32);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var blake2b = /* @__PURE__ */ createHasher((opts) => new _BLAKE2b(opts));

// dist/web/create-mock-host.js
var import_neverthrow = __toESM(require_index_cjs(), 1);
var import_truapi2 = require("@parity/truapi");

// dist/locale.js
var localizeTimestamps = async (request) => {
  if (!request.languageTag.trim() || !request.timeZone.trim()) {
    throw new RangeError("A language tag and time zone are required");
  }
  if (request.timestampsMs.length > 128 || request.timestampsMs.some((timestamp) => timestamp < 0n || timestamp > 253402300799999n)) {
    throw new RangeError("Timestamp batch or instant is out of range");
  }
  const { languageTag, timeZone } = request;
  const localDate = new Intl.DateTimeFormat("en-US", {
    calendar: "gregory",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const time = new Intl.DateTimeFormat(languageTag, {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  });
  const date = new Intl.DateTimeFormat(languageTag, {
    timeZone,
    dateStyle: "long"
  });
  const dateTime = new Intl.DateTimeFormat(languageTag, {
    timeZone,
    dateStyle: "full",
    timeStyle: "long"
  });
  return {
    timestamps: request.timestampsMs.map((timestamp) => {
      const instant = Number(timestamp);
      const parts = localDate.formatToParts(instant);
      const year = parts.find((part) => part.type === "year").value;
      const month = parts.find((part) => part.type === "month").value;
      const day = parts.find((part) => part.type === "day").value;
      if (year.length > 4) {
        throw new RangeError("Local date is outside the four-digit year range");
      }
      return {
        localDate: `${year.padStart(4, "0")}-${month}-${day}`,
        time: time.format(instant),
        date: date.format(instant),
        dateTime: dateTime.format(instant)
      };
    })
  };
};

// dist/web/loopback-statements.js
var import_truapi = require("@parity/truapi");
var SUBMIT = "statement_submit";
var SUBSCRIBE = "statement_subscribeStatement";
var UNSUBSCRIBE = "statement_unsubscribeStatement";
function hex(bytes2) {
  return `0x${Array.from(bytes2, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function bytes(value) {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  return Uint8Array.from((body.match(/../g) ?? []).map((b) => parseInt(b, 16)));
}
var StatementField = import_truapi.scale.TaggedUnion({
  Proof: import_truapi.StatementProof,
  DecryptionKey: import_truapi.scale.Hex(32),
  Expiry: import_truapi.scale.u64,
  Channel: import_truapi.scale.Hex(32),
  Topic1: import_truapi.scale.Hex(32),
  Topic2: import_truapi.scale.Hex(32),
  Topic3: import_truapi.scale.Hex(32),
  Topic4: import_truapi.scale.Hex(32),
  Data: import_truapi.scale.Hex()
});
var StatementFields = import_truapi.scale.Vector(StatementField);
var TOPIC_FIELD_TAGS = [
  "Topic1",
  "Topic2",
  "Topic3",
  "Topic4"
];
var TOPIC_TAGS = ["Topic1", "Topic2", "Topic3", "Topic4"];
function decodeStatement(encoded) {
  try {
    return StatementFields.dec(bytes(encoded));
  } catch {
    return void 0;
  }
}
function topicsOf(encoded) {
  const fields = decodeStatement(encoded);
  if (!fields)
    return void 0;
  return fields.filter((field) => TOPIC_TAGS.includes(field.tag)).map((field) => String(field.value).toLowerCase());
}
var UNVERIFIED_PROOF = {
  tag: "Sr25519",
  value: {
    signature: `0x${"00".repeat(64)}`,
    signer: `0x${"00".repeat(32)}`
  }
};
function encodeStatement(input) {
  if (input.topics.length > TOPIC_TAGS.length) {
    throw new Error(`testHost injectStatement: a statement carries at most ${TOPIC_TAGS.length} topics, and this one has ${input.topics.length}.`);
  }
  return hex(StatementFields.enc([
    { tag: "Proof", value: UNVERIFIED_PROOF },
    ...input.topics.map((topic, index) => ({
      tag: TOPIC_TAGS[index],
      value: topic
    })),
    ...input.data === void 0 ? [] : [{ tag: "Data", value: input.data }]
  ]));
}
function parseFilter(raw) {
  const toTopics = (values) => values.map((topic) => String(topic).toLowerCase());
  if (Array.isArray(raw))
    return { kind: "MatchAll", topics: toTopics(raw) };
  if (typeof raw !== "object" || raw === null) {
    return { kind: "MatchAll", topics: [] };
  }
  const filter = raw;
  for (const [key, kind] of [
    ["matchAny", "MatchAny"],
    ["matchAll", "MatchAll"]
  ]) {
    if (!(key in filter))
      continue;
    const topics = filter[key];
    return { kind, topics: Array.isArray(topics) ? toTopics(topics) : [] };
  }
  return { kind: "MatchAll", topics: [] };
}
function matches(subscription, topics) {
  if (subscription.topics.length === 0 || topics === void 0)
    return true;
  return subscription.kind === "MatchAll" ? subscription.topics.every((topic) => topics.includes(topic)) : subscription.topics.some((topic) => topics.includes(topic));
}
function createLoopbackStatements() {
  const subscriptions = /* @__PURE__ */ new Set();
  const retained = [];
  let nextId = 1;
  const notify = (subscription, encoded) => {
    subscription.notify(JSON.stringify({
      jsonrpc: "2.0",
      method: SUBSCRIBE,
      params: {
        subscription: subscription.id,
        result: {
          event: "newStatements",
          data: { statements: [encoded], remaining: 0 }
        }
      }
    }));
  };
  const deliver = (encoded) => {
    const topics = topicsOf(encoded);
    let delivered = 0;
    for (const subscription of subscriptions) {
      if (!matches(subscription, topics))
        continue;
      notify(subscription, encoded);
      delivered += 1;
    }
    return delivered;
  };
  return {
    handle(request, respond) {
      let frame;
      try {
        frame = JSON.parse(request);
      } catch {
        return false;
      }
      const reply = (result) => respond(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
      switch (frame.method) {
        case SUBMIT: {
          const encoded = String((frame.params ?? [])[0] ?? "");
          retained.push({ encoded, fromProduct: true, timestamp: Date.now() });
          reply({ status: "new" });
          deliver(encoded);
          return true;
        }
        case SUBSCRIBE: {
          const id = `loopback-sub-${nextId++}`;
          const subscription = {
            id,
            ...parseFilter((frame.params ?? [])[0]),
            notify: respond
          };
          subscriptions.add(subscription);
          reply(id);
          for (const statement of retained) {
            if (statement.fromProduct)
              continue;
            if (matches(subscription, topicsOf(statement.encoded))) {
              notify(subscription, statement.encoded);
            }
          }
          return true;
        }
        case UNSUBSCRIBE: {
          const target = String((frame.params ?? [])[0] ?? "");
          for (const subscription of subscriptions) {
            if (subscription.id === target)
              subscriptions.delete(subscription);
          }
          reply(true);
          return true;
        }
        default:
          return false;
      }
    },
    release(respond) {
      for (const subscription of subscriptions) {
        if (subscription.notify === respond)
          subscriptions.delete(subscription);
      }
    },
    statements: () => [...retained],
    // Narrowed by provenance rather than kept in a second list: `submitted()`
    // answers "did the product publish this", which an injection must not.
    submitted: () => retained.filter((statement) => statement.fromProduct),
    inject: (statement) => {
      const encoded = typeof statement === "string" ? statement.startsWith("0x") ? statement : `0x${statement}` : encodeStatement(statement);
      const entry = { encoded, fromProduct: false, timestamp: Date.now() };
      retained.push(entry);
      deliver(encoded);
      return entry;
    },
    clear: () => {
      retained.length = 0;
    }
  };
}

// dist/web/create-mock-host.js
function normalizePermissionPolicy(behavior) {
  if (behavior === "allow-all" || behavior === "deny-all")
    return behavior;
  if (behavior === "reject-all")
    return "deny-all";
  throw new Error(`testHost \`setPermissionBehavior\` does not know the policy "${String(behavior)}". Use "allow-all", or "deny-all" (which \`@parity/host-api-test-sdk\` spells "reject-all").`);
}
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
async function* failedSubscription(reason) {
  yield (0, import_neverthrow.err)({ reason });
}
function liveSubscription(first, closers, register) {
  const pending = [first];
  let wake;
  let released = false;
  const unregister = register((item) => {
    pending.push(item);
    wake?.();
    wake = void 0;
  });
  const release = () => {
    if (released)
      return;
    released = true;
    closers.delete(release);
    unregister();
    wake?.();
    wake = void 0;
  };
  closers.add(release);
  const stream = (async function* () {
    try {
      for (; ; ) {
        while (pending.length > 0)
          yield (0, import_neverthrow.ok)(pending.shift());
        if (released)
          return;
        await new Promise((resolve) => {
          wake = resolve;
        });
        if (released)
          return;
      }
    } finally {
      release();
    }
  })();
  const close = stream.return.bind(stream);
  const fail = stream.throw.bind(stream);
  stream.return = (value) => {
    release();
    return close(value);
  };
  stream.throw = (error) => {
    release();
    return fail(error);
  };
  return stream;
}
var NOT_MODELLED_REASONS = {
  payment: "the protocol declares payments but no host implements them; see docs/rfcs/0006-payments.md",
  coinPayment: "the protocol declares coin payments but no host implements them; see docs/rfcs/0006-payments.md",
  statements: "the core owns the statement store and submits it over the people chain, so there is no host seam for the mock to record or inject through"
};
function notModeled(domain) {
  return new Proxy({}, {
    get(_target, property) {
      const reason = NOT_MODELLED_REASONS[domain] ?? "no host implements this domain";
      throw new Error(`${domain}.${String(property)} is not available in the TrUAPI mock host: ${reason}.`);
    }
  });
}
function normalizeHash(hash) {
  if (typeof hash !== "string") {
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return hash.replace(/^0x/i, "").toLowerCase();
}
function recordChainSubmission(request, into) {
  try {
    const frame = JSON.parse(request);
    if (frame.method !== "statement_submit")
      return;
    const [statement] = frame.params ?? [];
    if (typeof statement !== "string")
      return;
    into.push({ encoded: statement, fromProduct: true, timestamp: Date.now() });
  } catch {
  }
}
function connectToChain(proxy, sentRpc, statementSubscriptions, loopback, injectors, disconnectors, submissions) {
  const socket = new WebSocket(proxy.rpcUrl);
  const queued = [];
  const waiting = [];
  let closed = false;
  const pendingStatementRequests = /* @__PURE__ */ new Set();
  const open = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`chain proxy failed to connect to ${proxy.rpcUrl}`)), { once: true });
  });
  const deliver = (text) => {
    const next = waiting.shift();
    if (next)
      next({ value: text, done: false });
    else
      queued.push(text);
  };
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    if (!text)
      return;
    if (statementSubscriptions)
      recordStatementSubscription(text);
    deliver(text);
  });
  const ownStatementSubscriptions = /* @__PURE__ */ new Set();
  const recordStatementSubscription = (text) => {
    try {
      const frame = JSON.parse(text);
      if (typeof frame.id === "string" && pendingStatementRequests.delete(frame.id) && typeof frame.result === "string") {
        statementSubscriptions?.add(frame.result);
        ownStatementSubscriptions.add(frame.result);
      }
    } catch {
    }
  };
  const inject = (frame) => {
    if (!closed)
      deliver(frame);
  };
  injectors?.add(inject);
  const finish = () => {
    closed = true;
    injectors?.delete(inject);
    disconnectors?.delete(finish);
    for (const id of ownStatementSubscriptions)
      statementSubscriptions?.delete(id);
    ownStatementSubscriptions.clear();
    loopback?.release(deliver);
    while (waiting.length > 0)
      waiting.shift()?.({ value: void 0, done: true });
  };
  disconnectors?.add(finish);
  socket.addEventListener("close", finish, { once: true });
  return {
    send(request) {
      sentRpc.push(request);
      if (submissions)
        recordChainSubmission(request, submissions);
      if (loopback?.handle(request, deliver))
        return;
      if (statementSubscriptions) {
        try {
          const frame = JSON.parse(request);
          if (frame.method === "statement_subscribeStatement" && typeof frame.id === "string") {
            pendingStatementRequests.add(frame.id);
          }
        } catch {
        }
      }
      void open.then(() => {
        if (!closed)
          socket.send(request);
      });
    },
    responses() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              const buffered = queued.shift();
              if (buffered !== void 0) {
                return Promise.resolve({ value: buffered, done: false });
              }
              if (closed)
                return Promise.resolve({ value: void 0, done: true });
              return new Promise((resolve) => waiting.push(resolve));
            }
          };
        }
      };
    },
    close() {
      finish();
      socket.close();
    }
  };
}
function preimageKey(value) {
  return blake2b(value, { dkLen: 32 });
}
function hex2(bytes2) {
  return Array.from(bytes2, (b) => b.toString(16).padStart(2, "0")).join("");
}
function createMockHost(config = {}) {
  const { devicePermissions: devicePermissionsInitial = "allow-all", remotePermissions: remotePermissionsInitial = "allow-all", featureSupported = true, theme = "Dark", confirmUserActions = true, chainResponses = [], chainClosed = false, chainProxies = [], languageTag = "en", timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, faults = {}, supportedChains = {
    network: "mock",
    chains: [
      { identifier: "People", genesisHash: MOCK_GENESIS.people },
      { identifier: "Bulletin", genesisHash: MOCK_GENESIS.bulletin },
      { identifier: "AssetHub", genesisHash: MOCK_GENESIS.assetHub }
    ]
  } } = config;
  const storage = /* @__PURE__ */ new Map();
  const preimages = /* @__PURE__ */ new Map();
  const navigations = [];
  const pushedNotifications = [];
  const statementSubscriptions = /* @__PURE__ */ new Set();
  const chainInjectors = /* @__PURE__ */ new Set();
  const chainDisconnectors = /* @__PURE__ */ new Set();
  const injectedStatements = [];
  const chainStatements = [];
  const loopbackStatements = createLoopbackStatements();
  const usingLoopback = (chainProxies ?? []).some((proxy) => proxy.loopbackStatements);
  const sentRpc = [];
  const authStates = [];
  const reviews = [];
  const cancelledNotifications = [];
  const permissionLog = [];
  const openOperations = [];
  let nextOperationId = 0;
  const permissionDecisions = /* @__PURE__ */ new Map();
  const chatRooms = /* @__PURE__ */ new Map();
  const chatBots = /* @__PURE__ */ new Map();
  const chatMessages = [];
  let nextNotificationId = 1;
  let nextChatMessageId = 0;
  let devicePermissions = devicePermissionsInitial;
  let remotePermissions = remotePermissionsInitial;
  let enforcePermissions = false;
  let currentTheme = theme;
  const subscriptionClosers = /* @__PURE__ */ new Set();
  const themeSubscribers = /* @__PURE__ */ new Set();
  const chatRoomSubscribers = /* @__PURE__ */ new Set();
  const byKey = (entries) => [...entries.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value);
  const publishChatRooms = () => {
    const item = { rooms: byKey(chatRooms) };
    for (const push of chatRoomSubscribers)
      push(item);
  };
  let chainStatus = "Idle";
  const decidePermission = (kind, tag, value, policy) => {
    const explicit = permissionDecisions.get(tag);
    const approved = explicit !== void 0 ? explicit : enforcePermissions ? false : granted(policy);
    permissionLog.push({
      tag,
      value,
      approved,
      kind,
      decision: decision(approved),
      timestamp: Date.now()
    });
    return approved;
  };
  const productKey = (key) => `product:${key}`;
  const coreKey = (key) => key.value === void 0 ? `core:${key.tag}` : (
    // Entries sorted, so a payload built field-by-field in a different
    // order still addresses the slot it addressed before.
    `core:${key.tag}:${JSON.stringify(key.value, (_, inner) => inner !== null && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left.localeCompare(right))) : inner)}`
  );
  const forgetStoredAuthorization = (permission) => {
    const prefix = "core:PermissionAuthorization:";
    const needle = JSON.stringify(permission);
    for (const key of [...storage.keys()]) {
      if (key.startsWith(prefix) && key.includes(needle))
        storage.delete(key);
    }
  };
  const asEntry = (statement) => {
    const fields = decodeStatement(statement.encoded) ?? [];
    const proof = fields.find((field) => field.tag === "Proof")?.value;
    return {
      topics: fields.filter((field) => TOPIC_FIELD_TAGS.includes(field.tag)).map((field) => String(field.value).toLowerCase()),
      data: fields.find((field) => field.tag === "Data")?.value,
      proof: proof && proof.tag !== "OnChain" ? { signature: proof.value.signature, signer: proof.value.signer } : void 0,
      fromProduct: statement.fromProduct,
      timestamp: statement.timestamp
    };
  };
  const granted = (policy) => policy === "allow-all";
  const decision = (approved) => approved ? "AllowAlways" : "Deny";
  const storageSubscribers = /* @__PURE__ */ new Map();
  const publishStorage = (key, value) => {
    const item = { value: value && import_truapi2.scale.bytesToHex(value) };
    for (const push of storageSubscribers.get(key) ?? [])
      push(item);
  };
  let hostCallCount = 0;
  const countCallsIn = (namespace) => {
    for (const [name, value] of Object.entries(namespace)) {
      if (typeof value !== "function")
        continue;
      const original = value;
      namespace[name] = (...args) => {
        hostCallCount += 1;
        return original.apply(namespace, args);
      };
    }
  };
  const callbacks = {
    productStorage: {
      async read(key) {
        if (faults.storageError)
          throw new Error(faults.storageError);
        return storage.get(productKey(key));
      },
      async write(key, value) {
        if (faults.storageError)
          throw new Error(faults.storageError);
        storage.set(productKey(key), value);
        publishStorage(key, value);
      },
      async clear(key) {
        if (faults.storageError)
          throw new Error(faults.storageError);
        storage.delete(productKey(key));
        publishStorage(key, void 0);
      },
      subscribeStorage(key) {
        const current = storage.get(productKey(key));
        return liveSubscription({ value: current && import_truapi2.scale.bytesToHex(current) }, subscriptionClosers, (push) => {
          const subscribers = storageSubscribers.get(key) ?? /* @__PURE__ */ new Set();
          storageSubscribers.set(key, subscribers);
          subscribers.add(push);
          return () => {
            subscribers.delete(push);
            if (subscribers.size === 0)
              storageSubscribers.delete(key);
          };
        });
      }
    },
    productOperations: {
      async beginOperation(product, label) {
        const id = nextOperationId++;
        openOperations.push({ productId: product.productId, id, label });
        return { id };
      },
      async endOperation(product, id) {
        const at = openOperations.findIndex((open) => open.id === id && open.productId === product.productId);
        if (at !== -1)
          openOperations.splice(at, 1);
      }
    },
    coreStorage: {
      async readCoreStorage(key) {
        if (faults.storageError)
          throw new Error(faults.storageError);
        return storage.get(coreKey(key));
      },
      async writeCoreStorage(key, value) {
        if (faults.storageError)
          throw new Error(faults.storageError);
        storage.set(coreKey(key), value);
      },
      async clearCoreStorage(key) {
        if (faults.storageError)
          throw new Error(faults.storageError);
        storage.delete(coreKey(key));
      }
    },
    navigation: {
      async navigateTo(url) {
        if (faults.navigateError)
          throw new Error(faults.navigateError);
        navigations.push(url);
      }
    },
    notifications: {
      async pushNotification(notification) {
        if (faults.notificationError)
          throw new Error(faults.notificationError);
        const id = nextNotificationId++;
        pushedNotifications.push({
          id,
          text: notification.text,
          deeplink: notification.deeplink,
          scheduledAt: notification.scheduledAt,
          cancelled: false,
          timestamp: Date.now()
        });
        return { id };
      },
      async cancelNotification(id) {
        cancelledNotifications.push(id);
        const entry = pushedNotifications.find((n) => n.id === id);
        if (entry)
          entry.cancelled = true;
      },
      async receiverAuthority() {
        return void 0;
      },
      async receiverConsent() {
        throw new Error("background receiving unsupported");
      },
      async receiverChanged() {
        throw new Error("background receiving unsupported");
      },
      async receiverCommand() {
        return void 0;
      },
      async activationEvents() {
        throw new Error("notification activation is unsupported");
      },
      async acknowledgeActivation() {
        throw new Error("notification activation is unsupported");
      }
    },
    permissions: {
      async devicePermission(_product, request) {
        if (faults.permissionError)
          throw new Error(faults.permissionError);
        return decision(decidePermission("device", request, request, devicePermissions));
      },
      async remotePermission(_product, request) {
        if (faults.permissionError)
          throw new Error(faults.permissionError);
        return decision(decidePermission("remote", request.permission.tag, request.permission, remotePermissions));
      }
    },
    features: {
      async featureSupported() {
        if (faults.featureError)
          throw new Error(faults.featureError);
        return { supported: featureSupported };
      },
      async supportedChains() {
        if (faults.featureError)
          throw new Error(faults.featureError);
        return supportedChains;
      }
    },
    chain: {
      async connect(genesisHash) {
        if (chainStatus === "Disconnected") {
          throw new Error("mock chain is disconnected");
        }
        const proxy = chainProxies.find((candidate) => candidate.genesisHash !== void 0 && normalizeHash(candidate.genesisHash) === normalizeHash(genesisHash)) ?? chainProxies.find((candidate) => candidate.genesisHash === void 0);
        if (proxy) {
          const connection = connectToChain(proxy, sentRpc, statementSubscriptions, proxy.loopbackStatements ? loopbackStatements : void 0, chainInjectors, chainDisconnectors, chainStatements);
          chainStatus = "Connected";
          return connection;
        }
        chainStatus = "Connected";
        let dropped;
        const transportDropped = new Promise((resolve) => {
          dropped = resolve;
        });
        const disconnect = () => dropped?.();
        chainDisconnectors.add(disconnect);
        return {
          send(request) {
            sentRpc.push(request);
            recordChainSubmission(request, chainStatements);
          },
          async *responses() {
            try {
              for (const frame of chainResponses) {
                yield frame;
              }
              if (chainResponses.length === 0 && !chainClosed) {
                await transportDropped;
              }
            } finally {
              chainDisconnectors.delete(disconnect);
            }
          },
          // The mock holds no real transport, so releasing the lease is a no-op.
          // Note: a Silent connection whose `responses()` stream is already parked
          // stays parked after close() — tests that need the stream to terminate use
          // `simulateDisconnect`, `chainClosed`, or scripted frames, not close().
          close() {
          }
        };
      }
    },
    auth: {
      authStateChanged(state) {
        authStates.push(state);
      }
    },
    userConfirmation: {
      async confirmUserAction(review) {
        reviews.push(review);
        if (faults.confirmationError)
          throw new Error(faults.confirmationError);
        return confirmUserActions;
      },
      // The Rust trait answers this from `confirm_user_action` by default, so
      // a review is recorded here too and one knob still answers both.
      async confirmPermission(review) {
        reviews.push(review);
        if (faults.confirmationError)
          throw new Error(faults.confirmationError);
        return decision(confirmUserActions);
      }
    },
    theme: {
      subscribeTheme() {
        return liveSubscription({ name: { tag: "Default" }, variant: currentTheme }, subscriptionClosers, (push) => {
          themeSubscribers.add(push);
          return () => themeSubscribers.delete(push);
        });
      }
    },
    chat: {
      async createChatRoom(_product, request) {
        if (faults.chatError)
          throw new Error(faults.chatError);
        if (chatRooms.has(request.roomId))
          return { status: "Exists" };
        chatRooms.set(request.roomId, {
          roomId: request.roomId,
          // A product that creates a room hosts it; a product reaching a room
          // as a bot registers the bot instead.
          participatingAs: "RoomHost"
        });
        publishChatRooms();
        return { status: "New" };
      },
      async registerChatBot(_product, request) {
        if (faults.chatError)
          throw new Error(faults.chatError);
        if (chatBots.has(request.botId))
          return { status: "Exists" };
        chatBots.set(request.botId, request);
        return { status: "New" };
      },
      async postChatMessage(_product, request) {
        if (faults.chatError)
          throw new Error(faults.chatError);
        if (!chatRooms.has(request.roomId)) {
          throw new Error(`unknown chat room ${request.roomId}`);
        }
        const messageId = `mock-message:${nextChatMessageId++}`;
        chatMessages.push({
          messageId,
          roomId: request.roomId,
          payload: request.payload
        });
        return { messageId };
      },
      subscribeChatRooms() {
        if (faults.chatError) {
          return failedSubscription(faults.chatError);
        }
        return liveSubscription({ rooms: byKey(chatRooms) }, subscriptionClosers, (push) => {
          chatRoomSubscribers.add(push);
          return () => chatRoomSubscribers.delete(push);
        });
      }
    },
    locale: {
      subscribeLocale() {
        return liveSubscription({ languageTag, timeZone }, subscriptionClosers, () => () => {
        });
      },
      localizeTimestamps
    },
    preimage: {
      async *lookupPreimage(key) {
        yield (0, import_neverthrow.ok)(preimages.get(hex2(key)));
        await new Promise(() => {
        });
      }
    }
  };
  for (const namespace of Object.values(callbacks)) {
    countCallsIn(namespace);
  }
  return {
    callbacks,
    getNavigationLog: () => [...navigations],
    getNotificationLog: () => pushedNotifications.map((n) => ({ ...n })),
    injectStatement: (statement) => {
      const encoded = typeof statement === "string" ? statement.startsWith("0x") ? statement : `0x${statement}` : statement instanceof Uint8Array ? `0x${hex2(statement)}` : encodeStatement(statement);
      injectedStatements.push(encoded);
      if (usingLoopback)
        return asEntry(loopbackStatements.inject(encoded));
      const entry = { encoded, fromProduct: false, timestamp: Date.now() };
      chainStatements.push(entry);
      for (const subscription of statementSubscriptions) {
        const frame = JSON.stringify({
          jsonrpc: "2.0",
          method: "statement_subscribeStatement",
          params: {
            subscription,
            result: {
              event: "newStatements",
              data: { statements: [encoded], remaining: 0 }
            }
          }
        });
        for (const injector of chainInjectors)
          injector(frame);
      }
      return asEntry(entry);
    },
    getInjectedStatements: () => [...injectedStatements],
    getStatements: () => (usingLoopback ? loopbackStatements.statements() : chainStatements).map(asEntry),
    getSubmittedStatements: () => (usingLoopback ? loopbackStatements.submitted() : chainStatements).filter((entry) => entry.fromProduct).map(asEntry),
    clearStatements: () => {
      injectedStatements.length = 0;
      loopbackStatements.clear();
      chainStatements.length = 0;
    },
    sentRpc: () => [...sentRpc],
    authStates: () => [...authStates],
    reviews: () => [...reviews],
    confirmations: () => reviews.map((review) => review.tag),
    getSigningLog: () => reviews.flatMap((review) => {
      const type = review.tag === "SignRaw" ? "raw" : review.tag === "SignPayload" ? "payload" : review.tag === "CreateTransaction" ? "createTransaction" : void 0;
      return type === void 0 ? [] : [{ type, payload: review.value }];
    }),
    getHostCallCount: () => hostCallCount,
    getIsAuthenticated: () => authStates.at(-1)?.tag === "Connected",
    getConnectionStatus: () => chainStatus,
    setPermissionBehavior: (behavior) => {
      const policy = normalizePermissionPolicy(behavior);
      devicePermissions = policy;
      remotePermissions = policy;
    },
    dispose() {
      this.reset();
      for (const close of [...subscriptionClosers])
        close();
      for (const disconnect of [...chainDisconnectors])
        disconnect();
    },
    cancelledNotifications: () => [...cancelledNotifications],
    getPermissionLog: () => [...permissionLog],
    getGrantedPermissions: () => [...permissionDecisions.entries()].filter(([, isGranted]) => isGranted).map(([permission]) => permission).sort(),
    grantPermission: (permission) => {
      permissionDecisions.set(permission, true);
      forgetStoredAuthorization(permission);
    },
    revokePermission: (permission) => {
      permissionDecisions.set(permission, false);
      forgetStoredAuthorization(permission);
    },
    resetPermission: (permission) => {
      permissionDecisions.delete(permission);
      forgetStoredAuthorization(permission);
    },
    setEnforcePermissions: (enforce) => {
      enforcePermissions = enforce;
    },
    getTheme: () => currentTheme,
    setTheme: (variant) => {
      currentTheme = variant;
      const item = {
        name: { tag: "Default" },
        variant
      };
      for (const push of themeSubscribers)
        push(item);
    },
    getChainStatus: () => chainStatus,
    simulateDisconnect: () => {
      chainStatus = "Disconnected";
      for (const disconnect of [...chainDisconnectors])
        disconnect();
    },
    simulateReconnect: () => {
      chainStatus = "Idle";
    },
    getOpenOperations: () => [...openOperations],
    getChatRooms: () => byKey(chatRooms),
    getChatBots: () => byKey(chatBots),
    getChatMessageLog: () => [...chatMessages],
    seedPreimage(value) {
      const key = preimageKey(value);
      preimages.set(hex2(key), value);
      return key;
    },
    getProductStorage: () => {
      const prefix = productKey("");
      const entries = {};
      for (const [key, value] of storage) {
        if (key.startsWith(prefix))
          entries[key.slice(prefix.length)] = value;
      }
      return entries;
    },
    getProductStorageValue: (key) => {
      const prefix = productKey("");
      for (const [stored, value] of storage) {
        if (!stored.startsWith(prefix))
          continue;
        const local = stored.slice(prefix.length);
        const namespaced = coreProductStorageKey(local);
        if ((namespaced ?? local) !== key)
          continue;
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(value);
        } catch {
          return void 0;
        }
      }
      return void 0;
    },
    getPreimages: () => [...preimages.values()],
    clearNavigationLog: () => {
      navigations.length = 0;
    },
    clearNotificationLog: () => {
      pushedNotifications.length = 0;
      cancelledNotifications.length = 0;
    },
    clearSigningLog: () => {
      reviews.length = 0;
    },
    clearPermissionLog: () => {
      permissionLog.length = 0;
    },
    clearPermissionDecisions: () => permissionDecisions.clear(),
    clearAuthStates: () => {
      authStates.length = 0;
    },
    clearSentRpc: () => {
      sentRpc.length = 0;
    },
    clearPreimages: () => preimages.clear(),
    clearStorage: () => storage.clear(),
    clearChatState: () => {
      chatRooms.clear();
      chatBots.clear();
      chatMessages.length = 0;
      publishChatRooms();
    },
    reset() {
      this.clearNavigationLog();
      this.clearNotificationLog();
      this.clearSigningLog();
      this.clearPermissionLog();
      this.clearPermissionDecisions();
      this.clearAuthStates();
      this.clearSentRpc();
      this.clearPreimages();
      this.clearStorage();
      this.clearChatState();
      this.clearStatements();
      openOperations.length = 0;
      nextOperationId = 0;
      this.setTheme(theme);
      devicePermissions = devicePermissionsInitial;
      remotePermissions = remotePermissionsInitial;
      chainStatus = "Idle";
      enforcePermissions = false;
      nextNotificationId = 1;
      nextChatMessageId = 0;
      hostCallCount = 0;
    },
    statements: notModeled("statements"),
    payment: notModeled("payment"),
    coinPayment: notModeled("coinPayment")
  };
}
var MOCK_GENESIS = {
  people: "0x1111111111111111111111111111111111111111111111111111111111111111",
  bulletin: "0x2222222222222222222222222222222222222222222222222222222222222222",
  assetHub: "0x3333333333333333333333333333333333333333333333333333333333333333"
};
function mockRuntimeConfig(overrides = {}) {
  return {
    productId: "mock.dot",
    host: {
      name: "Mock Host",
      icon: "https://example.invalid/mock.png",
      version: "0.0.0"
    },
    platform: {
      type: "node",
      version: "0"
    },
    people: { genesisHash: MOCK_GENESIS.people },
    bulletin: { genesisHash: MOCK_GENESIS.bulletin },
    assetHub: { genesisHash: MOCK_GENESIS.assetHub },
    pairing: {
      deeplinkScheme: "polkadotapp"
    },
    // A signing host refuses to start without this; a pairing host ignores it.
    // Setting it unconditionally keeps one config usable for both roles.
    networkSuffix: "paseo",
    ...overrides
  };
}

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

// dist/testing/create-mock-client.js
async function createMockClient(options = {}) {
  const wasmUrl = options.wasmUrl ?? new URL("../../dist/wasm/testing/truapi_server.js", __esm_import_meta_url).href;
  const glue = await import(
    /* @vite-ignore */
    wasmUrl
  );
  await glue.default();
  const { createWasmRawCallbacks: createWasmRawCallbacks2 } = await Promise.resolve().then(() => (init_host_callbacks_adapter(), host_callbacks_adapter_exports));
  const host = createMockHost(options.mock);
  const { productId, ...hostConfig } = mockRuntimeConfig(options.runtimeConfig ?? {});
  const runtime = new glue.WasmSigningHostRuntime({
    // Supplied outside the generated adapter, as the worker runtime does.
    ...createWasmRawCallbacks2(host.callbacks),
    workerDemandChanged: () => {
    }
  }, hostConfig);
  const account = resolveAccount(options.account ?? "alice");
  await runtime.activateLocalSession(account.entropy);
  const channel = new MessageChannel();
  const core = runtime.productRuntime({ productId }, {
    emitFrame(frame) {
      channel.port1.postMessage(frame);
    }
  });
  channel.port1.onmessage = (event) => {
    const frame = event.data;
    if (frame instanceof Uint8Array)
      void core.receiveFrame(frame);
  };
  channel.port1.start();
  const provider = (0, import_truapi5.createMessagePortProvider)(channel.port2);
  const transport = (0, import_truapi5.createTransport)(provider);
  const client = (0, import_truapi5.createClient)(transport);
  return {
    client,
    host,
    dispose() {
      provider.dispose();
      core.dispose();
      channel.port1.close();
      channel.port2.close();
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createMockClient
});
