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

// dist/generated/host-callbacks.js
var S, import_truapi, AccountAccessReview, AccountAliasReview, AuthState, ChatAuthorityReview, CoreStorageKey, CreateProofReview, CreateTransactionReview, DevicePermissionStatus, HostChainEntry, HostChainSet, IdentityDisclosureReview, LoginFailureKind, MainPurseChatPaymentReview, NativeChatFileExportRequest, NativeChatFilePickRequest, NativeChatPickedFile, NativeCoinageFailure, NativeCoinageMemo, NativeCoinageOperation, NativeCoinagePaymentIntent, NativeCoinageRequest, NativeCoinageResponse, NativeCoinageScope, NativeCoinageTopUpOutcome, PermissionAuthorizationRequest, PermissionAuthorizationStatus, PermissionDecision, PreimageSubmitReview, ProductContext, ProductExecutionKind, ProductSubtreeReview, ResourceAllocationReview, SessionUiInfo, SignPayloadReview, SignRawReview, SignVrfReview, StatementStoreProductSignReview, UserConfirmationReview;
var init_host_callbacks = __esm({
  "dist/generated/host-callbacks.js"() {
    "use strict";
    S = __toESM(require("@parity/truapi/scale"), 1);
    import_truapi = require("@parity/truapi");
    AccountAccessReview = S.lazy(() => S.Struct({ requestingProductId: S.str, targetProductId: S.str }));
    AccountAliasReview = S.lazy(() => S.Struct({ callingProductId: S.str, context: import_truapi.ProductProofContext, ringLocation: import_truapi.RingLocation }));
    AuthState = S.lazy(() => S.TaggedUnion({ Disconnected: S._void, Pairing: S.Struct({ deeplink: S.str }), Connected: SessionUiInfo, LoginFailed: S.Struct({ kind: LoginFailureKind, reason: S.str }), Authenticating: S._void }));
    ChatAuthorityReview = S.lazy(() => S.Struct({ productId: S.str }));
    CoreStorageKey = S.lazy(() => S.TaggedUnion({ AuthSession: S._void, PairingDeviceIdentity: S._void, PermissionAuthorization: S.Struct({ productId: S.str, request: PermissionAuthorizationRequest }), AllowanceKeys: S.Struct({ sessionId: S.str }), LastProcessedPairingStatement: S._void, AutoSigningKey: S.Struct({ productId: S.str }), AutoSigningKeys: S._void, RingVrfRegistry: S.Struct({ rootPublicKey: S.Bytes(32) }), StatementRenewalTargets: S._void, DeviceEncryptionKey: S._void, ProductSubtree: S.Struct({ sessionId: S.str, productId: S.str }), SsoResponderRequestLedger: S.Struct({ rootPublicKey: S.Bytes(32), peerStatementAccountId: S.Bytes(32), peerEncryptionPublicKey: S.Bytes(32) }), ProductManifest: S.Struct({ productId: S.str }), MainPurseCoinage: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32) }), NativeChatDevice: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32), productId: S.str }), NativeChatFileChunk: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32), productId: S.str, attachmentId: S.Bytes(32), chunkIndex: S.u32 }), NativeChatProducts: S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32) }), ProfileDisclosure: S._void, ProfileReferencesReceived: S.Struct({ productId: S.str }) }));
    CreateProofReview = S.lazy(() => S.Struct({ callingProductId: S.str, context: import_truapi.ProductProofContext, ringLocation: import_truapi.RingLocation, message: S.Bytes() }));
    CreateTransactionReview = S.lazy(() => S.TaggedUnion({ Product: import_truapi.ProductAccountTxPayload, LegacyAccount: import_truapi.LegacyAccountTxPayload }));
    DevicePermissionStatus = S.lazy(() => S.Status("Granted", "Denied", "NotDetermined", "NotApplicable"));
    HostChainEntry = S.lazy(() => S.Struct({ identifier: import_truapi.ChainIdentifier, genesisHash: import_truapi.Bytes32 }));
    HostChainSet = S.lazy(() => S.Struct({ network: S.str, chains: S.Vector(HostChainEntry) }));
    IdentityDisclosureReview = S.lazy(() => S.Struct({ productId: S.str }));
    LoginFailureKind = S.lazy(() => S.Status("NoFreeAllowanceSlots", "Other"));
    MainPurseChatPaymentReview = S.lazy(() => S.Struct({ callingProductId: S.str, recipientIdentity: S.Bytes(32), recipientUsername: S.Option(S.str), amountCents: S.u64, maxDebitCents: S.u64, genesisHash: S.Bytes(32), coinageInstanceId: S.Option(S.u32), operationId: S.Bytes(32) }));
    NativeChatFileExportRequest = S.lazy(() => S.Struct({ productId: S.str, peerIdentity: S.Bytes(32), peerUsername: S.Option(S.str), metadata: import_truapi.HostNativeChatAttachmentMetadata }));
    NativeChatFilePickRequest = S.lazy(() => S.Struct({ productId: S.str, peerIdentity: S.Bytes(32), peerUsername: S.Option(S.str), maxFiles: S.u32 }));
    NativeChatPickedFile = S.lazy(() => S.Struct({ sourceId: S.str, metadata: import_truapi.HostNativeChatAttachmentMetadata }));
    NativeCoinageFailure = S.lazy(() => S.Status("Unavailable", "InvalidRequest", "InvalidSource", "OperationConflict", "OperationNotFound", "InsufficientBalance", "UserRejected"));
    NativeCoinageMemo = S.lazy(() => S.Struct({ secretKeys: S.Vector(S.Bytes()), totalValueRaw: S.str }));
    NativeCoinageOperation = S.lazy(() => S.TaggedUnion({ Denomination: S._void, PreparePayment: S.Struct({ intent: NativeCoinagePaymentIntent }), CommitHandoff: S.Struct({ productId: S.str, operationId: S.Bytes(32) }), Views: S.Struct({ productId: S.str }), PendingHandoffs: S.Struct({ productId: S.str, acceptedOperations: S.Vector(S.Bytes(32)) }), ReadHandoff: S.Struct({ productId: S.str, operationId: S.Bytes(32) }), NoteDelivery: S.Struct({ productId: S.str, operationId: S.Bytes(32) }), Reconcile: S._void, TopUp: S.Struct({ productId: S.str, operationId: S.Bytes(32), minimumAmountRaw: S.str, secretKeys: S.Vector(S.Bytes()) }) }));
    NativeCoinagePaymentIntent = S.lazy(() => S.Struct({ operationId: S.Bytes(32), productId: S.str, requestId: S.str, peerIdentity: S.Bytes(32), recipientUsername: S.Option(S.str), amountCents: S.u64 }));
    NativeCoinageRequest = S.lazy(() => S.Struct({ scope: NativeCoinageScope, operation: NativeCoinageOperation }));
    NativeCoinageResponse = S.lazy(() => S.TaggedUnion({ Denomination: S.Struct({ centsUnitRaw: S.str }), Prepared: S.Struct({ payment: import_truapi.HostNativeChatPayment, memo: S.Option(NativeCoinageMemo) }), Payments: S.Struct({ payments: S.Vector(import_truapi.HostNativeChatPayment) }), TopUp: S.Struct({ outcome: NativeCoinageTopUpOutcome }), Done: S._void, Failed: S.Struct({ reason: NativeCoinageFailure }) }));
    NativeCoinageScope = S.lazy(() => S.Struct({ rootPublicKey: S.Bytes(32), genesisHash: S.Bytes(32), coinageInstanceId: S.Option(S.u32) }));
    NativeCoinageTopUpOutcome = S.lazy(() => S.TaggedUnion({ Cleared: S._void, Partial: S.Struct({ creditedAmountRaw: S.str }), Pending: S._void, NotClaimed: S._void }));
    PermissionAuthorizationRequest = S.lazy(() => S.TaggedUnion({ Device: import_truapi.HostDevicePermissionRequest, Remote: import_truapi.RemotePermissionRequest, IdentityDisclosure: S._void, AccountAccess: S.Struct({ targetProductId: S.str }), ChatAuthority: S._void, StatementStoreAllowance: S.Struct({ derivationIndex: S.Option(import_truapi.DerivationIndex) }) }));
    PermissionAuthorizationStatus = S.lazy(() => S.Status("NotDetermined", "Denied", "Authorized"));
    PermissionDecision = S.lazy(() => S.Status("AllowOnce", "AllowAlways", "Deny"));
    PreimageSubmitReview = S.lazy(() => S.Struct({ size: S.u64 }));
    ProductContext = S.lazy(() => S.Struct({ productId: S.str, executionKind: ProductExecutionKind }));
    ProductExecutionKind = S.lazy(() => S.Status("App", "Widget", "Worker"));
    ProductSubtreeReview = S.lazy(() => S.Struct({ productId: S.str }));
    ResourceAllocationReview = S.lazy(() => S.Struct({ callingProductId: S.str, resources: S.Vector(import_truapi.AllocatableResource) }));
    SessionUiInfo = S.lazy(() => S.Struct({ publicKey: import_truapi.Bytes32, identityAccountId: S.Option(import_truapi.Bytes32), chatPublicKey: S.Option(import_truapi.Bytes32), deviceEncPublicKey: S.Option(import_truapi.Bytes32), peerStatementAccountId: S.Option(import_truapi.Bytes32), deviceStatementAccountId: S.Option(import_truapi.Bytes32), liteUsername: S.Option(S.str), fullUsername: S.Option(S.str) }));
    SignPayloadReview = S.lazy(() => S.TaggedUnion({ Product: import_truapi.HostSignPayloadRequest, LegacyAccount: import_truapi.HostSignPayloadWithLegacyAccountRequest }));
    SignRawReview = S.lazy(() => S.TaggedUnion({ Product: S.Struct({ request: import_truapi.HostSignRawRequest, watermarked: S.bool }), LegacyAccount: S.Struct({ request: import_truapi.HostSignRawWithLegacyAccountRequest, watermarked: S.bool }) }));
    SignVrfReview = S.lazy(() => S.Struct({ callingProductId: S.str, request: import_truapi.HostAccountSignVrfRequest }));
    StatementStoreProductSignReview = S.lazy(() => S.Struct({ account: import_truapi.ProductAccountId, payload: S.Bytes() }));
    UserConfirmationReview = S.lazy(() => S.TaggedUnion({ SignPayload: SignPayloadReview, SignRaw: SignRawReview, StatementStoreProductSign: StatementStoreProductSignReview, CreateTransaction: CreateTransactionReview, AccountAlias: AccountAliasReview, CreateProof: CreateProofReview, IdentityDisclosure: IdentityDisclosureReview, ResourceAllocation: ResourceAllocationReview, PreimageSubmit: PreimageSubmitReview, AccountAccess: AccountAccessReview, SignVrf: SignVrfReview, ProductSubtree: ProductSubtreeReview, ChatAuthority: ChatAuthorityReview, MainPurseChatPayment: MainPurseChatPaymentReview }));
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
function toError(err2) {
  return err2 instanceof Error ? err2 : new Error(errorMessage(err2));
}
var init_error = __esm({
  "dist/error.js"() {
    "use strict";
  }
});

// dist/adapter-support.js
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
  const identityBackend = callbacks.identityBackend;
  const permissionStatus = callbacks.permissionStatus;
  const pocket = callbacks.pocket;
  const profile = callbacks.profile;
  const hop = callbacks.hop ?? unavailableHopProvider;
  const nativeChatFiles = callbacks.nativeChatFiles ?? unavailableNativeChatFilesHost;
  return {
    authStateChanged: async (state) => await callbacks.auth.authStateChanged(AuthState.dec(state)),
    chainConnect: chainConnectAdapter(callbacks.chain),
    ...chat ? {
      createChatRoom: async (product, request) => import_truapi2.HostChatCreateRoomResponse.enc(await chat.createChatRoom(ProductContext.dec(product), import_truapi2.HostChatCreateRoomRequest.dec(request))),
      registerChatBot: async (product, request) => import_truapi2.HostChatRegisterBotResponse.enc(await chat.registerChatBot(ProductContext.dec(product), import_truapi2.HostChatRegisterBotRequest.dec(request))),
      postChatMessage: async (product, request) => import_truapi2.HostChatPostMessageResponse.enc(await chat.postChatMessage(ProductContext.dec(product), import_truapi2.HostChatPostMessageRequest.dec(request))),
      subscribeChatRooms: (product, sendItem, sendError) => driveResultStream(chat.subscribeChatRooms(ProductContext.dec(product)), (item) => sendItem(import_truapi2.HostChatListSubscribeItem.enc(item)), sendError)
    } : {},
    ...coinageWallet ? {
      nativeCoinage: async (request) => NativeCoinageResponse.enc(await coinageWallet.nativeCoinage(NativeCoinageRequest.dec(request)))
    } : {},
    readCoreStorage: async (key) => await callbacks.coreStorage.readCoreStorage(CoreStorageKey.dec(key)),
    writeCoreStorage: async (key, value) => await callbacks.coreStorage.writeCoreStorage(CoreStorageKey.dec(key), value),
    clearCoreStorage: async (key) => await callbacks.coreStorage.clearCoreStorage(CoreStorageKey.dec(key)),
    featureSupported: async (request) => import_truapi2.HostFeatureSupportedResponse.enc(await callbacks.features.featureSupported(import_truapi2.HostFeatureSupportedRequest.dec(request))),
    supportedChains: async () => HostChainSet.enc(await callbacks.features.supportedChains()),
    allowedHopEndpoints: async (bulletinGenesisHash) => allowedHopEndpointsResultCodec.enc(await hop.allowedHopEndpoints(bulletinGenesisHash)),
    hopConnect: hopConnectAdapter(hop),
    ...identityBackend ? {
      identityUsernameCandidates: async (username, peopleChainGenesisHash) => identityUsernameCandidatesResultCodec.enc(await identityBackend.identityUsernameCandidates(username, peopleChainGenesisHash))
    } : {},
    subscribeLocale: (sendItem, sendError) => driveResultStream(callbacks.locale.subscribeLocale(), (item) => sendItem(import_truapi2.HostLocaleSubscribeItem.enc(item)), sendError),
    pickChatFiles: async (request) => pickChatFilesResultCodec.enc(await nativeChatFiles.pickChatFiles(NativeChatFilePickRequest.dec(request))),
    readChatFile: async (sourceId, offset, length) => await nativeChatFiles.readChatFile(sourceId, offset, length),
    releaseChatFile: async (sourceId) => await nativeChatFiles.releaseChatFile(sourceId),
    beginChatFileExport: async (request) => await nativeChatFiles.beginChatFileExport(NativeChatFileExportRequest.dec(request)),
    writeChatFileExport: async (exportId, offset, data) => await nativeChatFiles.writeChatFileExport(exportId, offset, data),
    finishChatFileExport: async (exportId) => await nativeChatFiles.finishChatFileExport(exportId),
    cancelChatFileExport: async (exportId) => await nativeChatFiles.cancelChatFileExport(exportId),
    navigateTo: async (url) => await callbacks.navigation.navigateTo(url),
    pushNotification: async (notification) => import_truapi2.HostPushNotificationResponse.enc(await callbacks.notifications.pushNotification(import_truapi2.HostPushNotificationRequest.dec(notification))),
    cancelNotification: async (id) => await callbacks.notifications.cancelNotification(id),
    ...permissionStatus ? {
      devicePermissionStatus: async (request) => DevicePermissionStatus.enc(await permissionStatus.devicePermissionStatus(import_truapi2.HostDevicePermissionRequest.dec(request)))
    } : {},
    devicePermission: async (product, request) => PermissionDecision.enc(await callbacks.permissions.devicePermission(ProductContext.dec(product), import_truapi2.HostDevicePermissionRequest.dec(request))),
    remotePermission: async (product, request) => PermissionDecision.enc(await callbacks.permissions.remotePermission(ProductContext.dec(product), import_truapi2.RemotePermissionRequest.dec(request))),
    ...pocket ? {
      subscribePocketCards: (product, sendItem, sendError) => driveResultStream(pocket.subscribePocketCards(ProductContext.dec(product)), (item) => sendItem(import_truapi2.HostPocketListSubscribeItem.enc(item)), sendError),
      removePocketCard: async (product, request) => await pocket.removePocketCard(ProductContext.dec(product), import_truapi2.HostPocketRemoveCardRequest.dec(request))
    } : {},
    lookupPreimage: (key, sendItem, sendError) => driveResultStream(callbacks.preimage.lookupPreimage(key), sendItem, sendError),
    beginOperation: async (product, label) => import_truapi2.HostWorkerBeginOperationResponse.enc(await callbacks.productOperations.beginOperation(ProductContext.dec(product), label)),
    endOperation: async (product, id) => await callbacks.productOperations.endOperation(ProductContext.dec(product), id),
    read: async (key) => await callbacks.productStorage.read(key),
    write: async (key, value) => await callbacks.productStorage.write(key, value),
    clear: async (key) => await callbacks.productStorage.clear(key),
    subscribeStorage: (key, sendItem, sendError) => driveResultStream(callbacks.productStorage.subscribeStorage(key), (item) => sendItem(import_truapi2.HostLocalStorageChangeItem.enc(item)), sendError),
    ...profile ? {
      presentProfile: async (product, request) => await profile.presentProfile(ProductContext.dec(product), import_truapi2.HostProfilePresentRequest.dec(request))
    } : {},
    subscribeTheme: (sendItem, sendError) => driveResultStream(callbacks.theme.subscribeTheme(), (item) => sendItem(import_truapi2.HostThemeSubscribeItem.enc(item)), sendError),
    confirmPermission: async (review) => PermissionDecision.enc(await callbacks.userConfirmation.confirmPermission(UserConfirmationReview.dec(review))),
    confirmUserAction: async (review) => await callbacks.userConfirmation.confirmUserAction(UserConfirmationReview.dec(review))
  };
}
var S2, import_truapi2, allowedHopEndpointsResultCodec, identityUsernameCandidatesResultCodec, pickChatFilesResultCodec;
var init_host_callbacks_adapter = __esm({
  "dist/generated/host-callbacks-adapter.js"() {
    "use strict";
    S2 = __toESM(require("@parity/truapi/scale"), 1);
    import_truapi2 = require("@parity/truapi");
    init_host_callbacks();
    init_adapter_support();
    allowedHopEndpointsResultCodec = S2.Vector(S2.str);
    identityUsernameCandidatesResultCodec = S2.Vector(S2.Bytes(32));
    pickChatFilesResultCodec = S2.Vector(NativeChatPickedFile);
  }
});

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

// dist/testing/host-page.js
var host_page_exports = {};
__export(host_page_exports, {
  PRODUCT_FRAME_ID: () => PRODUCT_FRAME_ID,
  publishTestHostGlobals: () => publishTestHostGlobals,
  startTestHost: () => startTestHost
});
module.exports = __toCommonJS(host_page_exports);

// dist/web/create-iframe-host.js
var DEFAULT_IFRAME_SANDBOX = "allow-forms allow-same-origin allow-scripts";
function sandboxCreatesOpaqueOrigin(sandbox) {
  return !sandbox.toLowerCase().split(/\s+/).includes("allow-same-origin");
}
function resolveAllowedOrigin(iframeUrl, allowedOrigin) {
  const targetUrl = new URL(iframeUrl, window.location.href);
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new Error(`Iframe host only allows http(s) product URLs, received ${targetUrl.protocol}`);
  }
  if (!allowedOrigin) {
    return targetUrl.origin;
  }
  const normalizedOrigin = new URL(allowedOrigin).origin;
  if (normalizedOrigin !== targetUrl.origin) {
    throw new Error(`Iframe host origin policy mismatch, expected ${normalizedOrigin}, got ${targetUrl.origin}`);
  }
  return normalizedOrigin;
}
function createIframeHost(options) {
  const { iframeUrl, container, onPort, allowedOrigin, allow, sandbox = DEFAULT_IFRAME_SANDBOX } = options;
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const productPort = channel.port2;
  const targetOrigin = resolveAllowedOrigin(iframeUrl, allowedOrigin);
  onPort(hostPort);
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "none";
  const credentiallessIframe = iframe;
  credentiallessIframe.credentialless = true;
  if (allow !== void 0) {
    iframe.allow = allow;
  }
  iframe.setAttribute("sandbox", sandbox);
  iframe.referrerPolicy = "no-referrer";
  iframe.src = iframeUrl;
  const acceptsOpaqueOrigin = sandboxCreatesOpaqueOrigin(sandbox);
  const initTargetOrigin = acceptsOpaqueOrigin ? "*" : targetOrigin;
  let initSent = false;
  const sendInit = () => {
    if (initSent)
      return;
    const contentWindow = iframe.contentWindow;
    if (!contentWindow)
      return;
    initSent = true;
    contentWindow.postMessage({ type: "truapi-init" }, initTargetOrigin, [
      productPort
    ]);
  };
  const onWindowMessage = (event) => {
    if (event.source !== iframe.contentWindow)
      return;
    if (event.origin !== targetOrigin && !(acceptsOpaqueOrigin && event.origin === "null")) {
      return;
    }
    if (event.data?.type === "truapi-ready") {
      sendInit();
    }
  };
  window.addEventListener("message", onWindowMessage);
  container.appendChild(iframe);
  return {
    iframe,
    dispose() {
      window.removeEventListener("message", onWindowMessage);
      try {
        hostPort.close();
      } catch {
      }
      try {
        productPort.close();
      } catch {
      }
      iframe.remove();
    }
  };
}

// dist/web/create-worker-host-runtime.js
var import_truapi3 = require("@parity/truapi");
init_host_callbacks();
init_host_callbacks_adapter();

// dist/worker-protocol.js
var MAX_JSON_RPC_CONNECTIONS = 64;
var COINAGE_WALLET_CALLBACKS = {
  nativeCoinage: true
};

// dist/web/create-worker-host-runtime.js
var import_scale3 = require("@parity/truapi/scale");

// dist/generated/worker-callbacks.js
function startRawSubscription(callbacks, name, payload, sendItem, sendError) {
  switch (name) {
    case "subscribeChatRooms":
      if (!(payload instanceof Uint8Array)) {
        console.warn(`[truapi worker] ${name} requires payload`);
        return void 0;
      }
      return callbacks.subscribeChatRooms?.(payload, sendItem, sendError);
    case "subscribeLocale":
      return callbacks.subscribeLocale(sendItem, sendError);
    case "subscribePocketCards":
      if (!(payload instanceof Uint8Array)) {
        console.warn(`[truapi worker] ${name} requires payload`);
        return void 0;
      }
      return callbacks.subscribePocketCards?.(payload, sendItem, sendError);
    case "lookupPreimage":
      if (!(payload instanceof Uint8Array)) {
        console.warn(`[truapi worker] ${name} requires payload`);
        return void 0;
      }
      return callbacks.lookupPreimage(payload, sendItem, sendError);
    case "subscribeStorage":
      if (typeof payload !== "string") {
        console.warn(`[truapi worker] ${name} requires payload`);
        return void 0;
      }
      return callbacks.subscribeStorage(payload, sendItem, sendError);
    case "subscribeTheme":
      return callbacks.subscribeTheme(sendItem, sendError);
  }
}

// dist/web/create-worker-host-runtime.js
init_error();

// dist/web/native-chat-files.js
var import_scale2 = require("@parity/truapi/scale");

// dist/web/native-chat-media.js
var HEADER_LIMIT = 65536;
var VIDEO_TIMEOUT_MS = 5e3;
var U32_MAX = 4294967295;
var MP4_BRANDS = [
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "M4VH",
  "M4VP"
];
var PNG_DEPTHS = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16]
};
function matches(bytes2, offset, signature) {
  if (offset + signature.length > bytes2.length)
    return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes2[offset + i] !== signature.charCodeAt(i))
      return false;
  }
  return true;
}
function imageHeader(bytes2, fileSize) {
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  if (bytes2.length >= 33 && matches(bytes2, 0, "\x89PNG\r\n\n") && view.getUint32(8) === 13 && matches(bytes2, 12, "IHDR")) {
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width > 0 && height > 0 && width <= 2147483647 && height <= 2147483647 && PNG_DEPTHS[bytes2[25]]?.includes(bytes2[24]) && bytes2[26] === 0 && bytes2[27] === 0 && bytes2[28] <= 1) {
      return { mimeType: "image/png", width, height };
    }
    return void 0;
  }
  if (bytes2.length >= 13 && (matches(bytes2, 0, "GIF87a") || matches(bytes2, 0, "GIF89a"))) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    if (width && height)
      return { mimeType: "image/gif", width, height };
    return void 0;
  }
  if (bytes2.length >= 4 && bytes2[0] === 255 && bytes2[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes2.length) {
      if (bytes2[offset++] !== 255)
        return void 0;
      while (offset < bytes2.length && bytes2[offset] === 255)
        offset++;
      const marker = bytes2[offset++];
      if (marker === void 0 || marker === 218 || marker === 217 || marker === 0)
        return void 0;
      if (marker === 1 || marker >= 208 && marker <= 215)
        continue;
      if (offset + 2 > bytes2.length)
        return void 0;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes2.length)
        return void 0;
      if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
        if (length < 8)
          return void 0;
        const height = view.getUint16(offset + 3);
        const width = view.getUint16(offset + 5);
        const components = bytes2[offset + 7];
        if (width && height && components > 0 && length === 8 + 3 * components) {
          return { mimeType: "image/jpeg", width, height };
        }
        return void 0;
      }
      offset += length;
    }
    return void 0;
  }
  if (bytes2.length >= 30 && matches(bytes2, 0, "RIFF") && matches(bytes2, 8, "WEBP") && view.getUint32(4, true) + 8 === fileSize) {
    const chunkSize = view.getUint32(16, true);
    if (20 + chunkSize + (chunkSize & 1) > fileSize)
      return void 0;
    if (matches(bytes2, 12, "VP8X") && chunkSize === 10) {
      const width = 1 + bytes2[24] + (bytes2[25] << 8) + (bytes2[26] << 16);
      const height = 1 + bytes2[27] + (bytes2[28] << 8) + (bytes2[29] << 16);
      return { mimeType: "image/webp", width, height };
    }
    if (matches(bytes2, 12, "VP8 ") && chunkSize >= 10 && (bytes2[20] & 1) === 0 && matches(bytes2, 23, "\x9D*")) {
      const width = view.getUint16(26, true) & 16383;
      const height = view.getUint16(28, true) & 16383;
      if (width && height)
        return { mimeType: "image/webp", width, height };
    }
  }
  if (bytes2.length >= 25 && matches(bytes2, 0, "RIFF") && matches(bytes2, 8, "WEBP") && matches(bytes2, 12, "VP8L") && view.getUint32(4, true) + 8 === fileSize) {
    const chunkSize = view.getUint32(16, true);
    if (chunkSize >= 5 && 20 + chunkSize + (chunkSize & 1) <= fileSize && bytes2[20] === 47 && bytes2[24] >> 5 === 0) {
      const width = 1 + bytes2[21] + ((bytes2[22] & 63) << 8);
      const height = 1 + (bytes2[22] >> 6) + (bytes2[23] << 2) + ((bytes2[24] & 15) << 10);
      return { mimeType: "image/webp", width, height };
    }
  }
  return void 0;
}
function ebmlInteger(bytes2, offset, id) {
  const first = bytes2[offset];
  if (first === void 0 || first === 0)
    return void 0;
  let marker = 128;
  let length = 1;
  while ((first & marker) === 0) {
    marker >>= 1;
    length++;
  }
  if (length > (id ? 4 : 8) || offset + length > bytes2.length)
    return void 0;
  let value = id ? first : first & marker - 1;
  for (let i = 1; i < length; i++)
    value = value * 256 + bytes2[offset + i];
  if (!Number.isSafeInteger(value) || !id && value === 2 ** (7 * length) - 1)
    return void 0;
  return { value, next: offset + length };
}
function videoMime(bytes2, fileSize) {
  if (bytes2.length >= 16 && matches(bytes2, 4, "ftyp")) {
    const size = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength).getUint32(0);
    if (size < 16 || size > bytes2.length || size > fileSize || size % 4 !== 0)
      return void 0;
    if (matches(bytes2, 8, "qt  "))
      return "video/quicktime";
    for (const brand of MP4_BRANDS) {
      if (matches(bytes2, 8, brand))
        return "video/mp4";
    }
    return void 0;
  }
  if (!matches(bytes2, 0, "E\xDF\xA3"))
    return void 0;
  const header = ebmlInteger(bytes2, 4, false);
  if (!header || header.value > bytes2.length - header.next)
    return void 0;
  const end = header.next + header.value;
  if (!matches(bytes2, end, "S\x80g"))
    return void 0;
  let offset = header.next;
  let webm = false;
  while (offset < end) {
    const id = ebmlInteger(bytes2, offset, true);
    if (!id || id.next > end)
      return void 0;
    const size = ebmlInteger(bytes2, id.next, false);
    if (!size || size.next > end || size.value > end - size.next)
      return void 0;
    if (id.value === 17026) {
      if (webm || size.value !== 4 || !matches(bytes2, size.next, "webm"))
        return void 0;
      webm = true;
    }
    offset = size.next + size.value;
  }
  return webm ? "video/webm" : void 0;
}
async function inspectNativeChatFileMetadata(blob, signal) {
  if (!Number.isInteger(blob.size) || blob.size < 0 || blob.size > U32_MAX)
    throw new Error("Chat file size exceeds the supported range");
  const fallback = {
    mimeType: "application/octet-stream",
    sizeBytes: blob.size,
    kind: { tag: "File" }
  };
  if (signal?.aborted)
    return fallback;
  const bytes2 = new Uint8Array(await blob.slice(0, HEADER_LIMIT).arrayBuffer());
  if (signal?.aborted)
    return fallback;
  const image = imageHeader(bytes2, blob.size);
  if (image) {
    return {
      mimeType: image.mimeType,
      sizeBytes: blob.size,
      kind: {
        tag: "Image",
        value: {
          width: image.width,
          height: image.height,
          thumbnail: void 0
        }
      }
    };
  }
  const mimeType = videoMime(bytes2, blob.size);
  if (!mimeType || typeof document === "undefined")
    return fallback;
  let video;
  let url;
  try {
    video = document.createElement("video");
    video.preload = "metadata";
    video.autoplay = false;
    video.muted = true;
    video.playsInline = true;
    url = URL.createObjectURL(blob.slice(0, blob.size, mimeType));
  } catch {
    return fallback;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (metadata) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      video.onloadedmetadata = video.onerror = null;
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
      } finally {
        URL.revokeObjectURL(url);
        resolve(metadata);
      }
    };
    const abort = () => finish(fallback);
    const timer = setTimeout(abort, VIDEO_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    video.onerror = abort;
    video.onloadedmetadata = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration < 0 || duration > U32_MAX || video.videoWidth <= 0 || video.videoHeight <= 0) {
        finish(fallback);
      } else {
        finish({
          mimeType,
          sizeBytes: blob.size,
          kind: {
            tag: "Video",
            value: {
              durationSeconds: Math.floor(duration),
              thumbnail: void 0
            }
          }
        });
      }
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      video.src = url;
      video.load();
    } catch {
      abort();
    }
  });
}
var IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};
var VIDEO_EXTENSIONS = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm"
};
function nativeChatExportFilename(metadata) {
  let extension = "bin";
  if (metadata.kind.tag === "Image") {
    const { width, height } = metadata.kind.value;
    if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= U32_MAX && height <= U32_MAX && Object.hasOwn(IMAGE_EXTENSIONS, metadata.mimeType)) {
      extension = IMAGE_EXTENSIONS[metadata.mimeType];
    }
  } else if (metadata.kind.tag === "Video") {
    const { durationSeconds } = metadata.kind.value;
    if (Number.isInteger(durationSeconds) && durationSeconds >= 0 && durationSeconds <= U32_MAX && Object.hasOwn(VIDEO_EXTENSIONS, metadata.mimeType)) {
      extension = VIDEO_EXTENSIONS[metadata.mimeType];
    }
  }
  return `chat-attachment.${extension}`;
}

// dist/web/native-chat-files.js
var MAX_FILE_SIZE = 4294967295;
var MAX_READ_SIZE = 2e6;
var DATABASE_NAME = "truapi-native-chat-files";
var SOURCE_STORE = "sources";
function checkedSize(size) {
  if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_SIZE) {
    throw new Error("Chat file size exceeds the supported range");
  }
}
function safeLabel(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").slice(0, 200);
}
function createBrowserNativeChatFilesHost(sourceStore) {
  let disposed = false;
  let database;
  const dialogs = /* @__PURE__ */ new Set();
  const exports2 = /* @__PURE__ */ new Map();
  const mediaAbort = new AbortController();
  function available() {
    if (disposed)
      throw new Error("Native Chat files are unavailable");
  }
  function openDatabase(cleanup = false) {
    if (!cleanup)
      available();
    if (!database) {
      database = new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
          reject(new Error("Durable Chat file storage is unavailable"));
          return;
        }
        const request = indexedDB.open(DATABASE_NAME, 1);
        let blocked = false;
        request.onupgradeneeded = () => request.result.createObjectStore(SOURCE_STORE);
        request.onerror = () => reject(new Error("Durable Chat file storage is unavailable"));
        request.onblocked = () => {
          blocked = true;
          reject(new Error("Durable Chat file storage is blocked"));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked || disposed && !cleanup) {
            db.close();
            reject(new Error("Native Chat files are unavailable"));
            return;
          }
          db.onversionchange = () => {
            db.close();
            database = void 0;
          };
          resolve(db);
        };
      }).catch((error) => {
        database = void 0;
        throw error;
      });
    }
    return database;
  }
  async function store(mode, action, cleanup = false) {
    const db = await openDatabase(cleanup);
    if (!cleanup)
      available();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SOURCE_STORE, mode, {
        durability: "strict"
      });
      const request = action(transaction.objectStore(SOURCE_STORE));
      transaction.oncomplete = () => {
        if (disposed) {
          db.close();
          database = void 0;
        }
        resolve(request.result);
      };
      transaction.onerror = transaction.onabort = () => reject(new Error("Chat file storage failed"));
    });
  }
  function prompt(title, context, actionLabel, configure) {
    available();
    if (typeof document === "undefined" || !document.body || window.top !== window) {
      return Promise.reject(new Error("Trusted Chat file presentation is unavailable"));
    }
    return new Promise((resolve, reject) => {
      const dialog = document.createElement("dialog");
      const heading = document.createElement("h2");
      heading.textContent = title;
      const summary = document.createElement("p");
      summary.textContent = `Product: ${safeLabel(context.productId)}
Peer: ${safeLabel(context.peerUsername ?? "Chat contact")}
Identity: ${(0, import_scale2.bytesToHex)(context.peerIdentity)}`;
      summary.style.whiteSpace = "pre-wrap";
      summary.style.overflowWrap = "anywhere";
      const content = document.createElement("div");
      const accept = document.createElement("button");
      accept.type = "button";
      accept.textContent = actionLabel;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      dialog.setAttribute("aria-label", title);
      dialog.style.maxWidth = "min(36rem, 90vw)";
      dialog.append(heading, summary, content, accept, cancel);
      let settled = false;
      let busy = false;
      const close = () => {
        dialogs.delete(abort);
        dialog.close();
        dialog.remove();
      };
      const abort = () => {
        if (settled)
          return;
        close();
        if (busy && disposed)
          return;
        settled = true;
        resolve(void 0);
      };
      dialogs.add(abort);
      cancel.onclick = abort;
      dialog.oncancel = (event) => {
        event.preventDefault();
        if (!busy)
          abort();
      };
      try {
        const run = configure(content);
        accept.onclick = () => {
          if (busy || settled)
            return;
          busy = true;
          accept.disabled = cancel.disabled = true;
          let result;
          try {
            result = run();
          } catch (error) {
            result = Promise.reject(error);
          }
          Promise.resolve(result).then((value) => {
            if (!settled) {
              settled = true;
              close();
              resolve(value);
            }
          }, (error) => {
            if (settled)
              return;
            busy = false;
            if (error instanceof DOMException && error.name === "AbortError") {
              abort();
              return;
            }
            settled = true;
            close();
            reject(new Error("Chat file selection or export failed"));
          });
        };
        document.body.append(dialog);
        dialog.showModal();
      } catch {
        settled = true;
        close();
        reject(new Error("Trusted Chat file presentation is unavailable"));
      }
    });
  }
  async function abortExport(id, entry) {
    exports2.delete(id);
    try {
      await entry.writer.abort();
    } catch {
    }
    await entry.removePartial();
  }
  function withExport(id, action) {
    const entry = exports2.get(id);
    if (!entry)
      return Promise.reject(new Error("Chat file export is unavailable"));
    const operation = entry.queue.then(async () => {
      if (exports2.get(id) !== entry)
        throw new Error("Chat file export is unavailable");
      await action(entry);
    });
    entry.queue = operation.catch(() => {
    });
    return operation;
  }
  const host = {
    async pickChatFiles(request) {
      checkedSize(request.maxFiles);
      if (request.maxFiles === 0)
        throw new Error("Chat file selection is unavailable");
      if (!sourceStore)
        await openDatabase();
      const files = await prompt("Send Chat attachments", request, "Attach files", (content) => {
        const label = document.createElement("label");
        label.textContent = `Choose up to ${request.maxFiles} files. The Host keeps a private copy until the transfer is released.`;
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = request.maxFiles > 1;
        label.append(input);
        content.append(label);
        return () => {
          const selected = Array.from(input.files ?? []);
          if (selected.length > request.maxFiles)
            throw new Error("Too many Chat attachments");
          for (const file of selected)
            checkedSize(file.size);
          return selected;
        };
      });
      if (!files?.length)
        return [];
      available();
      const picked = files.map((file) => ({
        sourceId: crypto.randomUUID(),
        metadata: {
          // Initial safe metadata is refined only from the committed immutable Blob.
          mimeType: "application/octet-stream",
          sizeBytes: file.size,
          kind: { tag: "File" }
        }
      }));
      if (sourceStore) {
        await sourceStore.putSources(files.map((file, index) => ({
          sourceId: picked[index].sourceId,
          blob: file.slice(0, file.size, "application/octet-stream")
        })));
      } else {
        const db = await openDatabase();
        available();
        await new Promise((resolve, reject) => {
          const transaction = db.transaction(SOURCE_STORE, "readwrite", {
            durability: "strict"
          });
          transaction.oncomplete = () => resolve();
          transaction.onerror = transaction.onabort = () => reject(new Error("Chat file snapshot failed"));
          const sources = transaction.objectStore(SOURCE_STORE);
          try {
            files.forEach((file, index) => {
              sources.add({
                blob: file.slice(0, file.size, "application/octet-stream")
              }, picked[index].sourceId);
            });
          } catch {
            transaction.abort();
          }
        });
      }
      try {
        for (const file of picked) {
          if (disposed)
            break;
          const record = sourceStore ? { blob: await sourceStore.readSource(file.sourceId) } : await store("readonly", (sources) => sources.get(file.sourceId));
          if (!record || !(record.blob instanceof Blob))
            throw new Error("Chat file snapshot is unavailable");
          file.metadata = await inspectNativeChatFileMetadata(record.blob, mediaAbort.signal);
        }
        if (!disposed)
          return picked;
      } catch {
        await Promise.all(picked.map((file) => host.releaseChatFile(file.sourceId)));
        if (!disposed)
          throw new Error("Chat file snapshot inspection failed");
        return [];
      }
      await Promise.all(picked.map((file) => host.releaseChatFile(file.sourceId)));
      return [];
    },
    async readChatFile(sourceId, offset, length) {
      checkedSize(length);
      if (length > MAX_READ_SIZE || offset < 0n || offset > BigInt(MAX_FILE_SIZE)) {
        throw new Error("Chat file read is out of bounds");
      }
      const record = sourceStore ? { blob: await sourceStore.readSource(sourceId) } : await store("readonly", (sources) => sources.get(sourceId));
      if (!record || !(record.blob instanceof Blob))
        throw new Error("Chat file source is unavailable");
      checkedSize(record.blob.size);
      if (offset + BigInt(length) > BigInt(record.blob.size))
        throw new Error("Chat file read is out of bounds");
      const start = Number(offset);
      const bytes2 = new Uint8Array(await record.blob.slice(start, start + length).arrayBuffer());
      if (bytes2.byteLength !== length)
        throw new Error("Chat file snapshot read failed");
      return bytes2;
    },
    async releaseChatFile(sourceId) {
      if (sourceStore) {
        await sourceStore.releaseSource(sourceId);
        return;
      }
      await store("readwrite", (sources) => sources.delete(sourceId), true);
    },
    async beginChatFileExport(request) {
      available();
      checkedSize(request.metadata.sizeBytes);
      const id = crypto.randomUUID();
      const filename = nativeChatExportFilename(request.metadata);
      const entry = await prompt("Save Chat attachment", request, "Choose destination", (content) => {
        const description = document.createElement("p");
        description.textContent = `${request.metadata.sizeBytes} bytes. Saved as a download, never opened or executed automatically.`;
        content.append(description);
        return async () => {
          const picker = window.showSaveFilePicker;
          let writer;
          let removePartial = async () => {
          };
          let presentCompleted;
          if (picker) {
            const handle = await picker.call(window, {
              suggestedName: filename
            });
            writer = await handle.createWritable();
          } else {
            if (!navigator.storage?.getDirectory)
              throw new Error("Streaming Chat file export is unavailable");
            const root = await navigator.storage.getDirectory();
            const directory = await root.getDirectoryHandle("truapi-chat-exports", { create: true });
            const handle = await directory.getFileHandle(id, {
              create: true
            });
            removePartial = () => directory.removeEntry(id);
            try {
              writer = await handle.createWritable();
            } catch (error) {
              await removePartial();
              throw error;
            }
            presentCompleted = async () => {
              const file = await handle.getFile();
              const url = URL.createObjectURL(file.slice(0, file.size, "application/octet-stream"));
              let downloaded = false;
              try {
                await prompt("Chat attachment ready", request, "Done", (body) => {
                  const link = document.createElement("a");
                  link.textContent = "Download attachment";
                  link.href = url;
                  link.download = filename;
                  link.onclick = () => {
                    downloaded = true;
                  };
                  body.append(link);
                  return () => void 0;
                });
              } finally {
                URL.revokeObjectURL(url);
                if (downloaded)
                  await removePartial();
              }
            };
          }
          const result = {
            writer,
            size: request.metadata.sizeBytes,
            written: 0,
            queue: Promise.resolve(),
            removePartial,
            presentCompleted
          };
          if (disposed) {
            try {
              await writer.abort();
            } finally {
              await removePartial();
            }
            return void 0;
          }
          return result;
        };
      });
      if (!entry)
        return void 0;
      if (disposed) {
        await abortExport(id, entry);
        return void 0;
      }
      exports2.set(id, entry);
      return id;
    },
    async writeChatFileExport(exportId, offset, data) {
      available();
      await withExport(exportId, async (entry) => {
        if (data.byteLength > MAX_READ_SIZE || offset !== BigInt(entry.written) || BigInt(data.byteLength) + offset > BigInt(entry.size)) {
          throw new Error("Chat file export write is out of bounds or not contiguous");
        }
        try {
          await entry.writer.write(data);
          entry.written += data.byteLength;
        } catch {
          await abortExport(exportId, entry);
          throw new Error("Chat file export write failed");
        }
      });
    },
    async finishChatFileExport(exportId) {
      available();
      await withExport(exportId, async (entry) => {
        if (entry.written !== entry.size)
          throw new Error("Chat file export is incomplete");
        try {
          await entry.writer.close();
        } catch {
          await abortExport(exportId, entry);
          throw new Error("Chat file export could not be saved");
        }
        exports2.delete(exportId);
        if (entry.presentCompleted && !disposed)
          await entry.presentCompleted();
      });
    },
    async cancelChatFileExport(exportId) {
      const entry = exports2.get(exportId);
      if (!entry)
        return;
      const operation = entry.queue.then(async () => {
        if (exports2.get(exportId) === entry)
          await abortExport(exportId, entry);
      });
      entry.queue = operation.catch(() => {
      });
      await operation;
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      mediaAbort.abort();
      for (const abort of dialogs)
        abort();
      for (const id of exports2.keys())
        void host.cancelChatFileExport(id).catch(() => {
        });
      const opening = database;
      database = void 0;
      void opening?.then((db) => db.close(), () => {
      });
    }
  };
  return host;
}

// dist/wallet-allowances.js
function validateAllowanceProductIds(value) {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length) {
    throw new Error("allowance inspection requires at most 32 unique nonempty product IDs");
  }
  for (const id of value) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("allowance inspection requires nonempty product IDs");
    }
  }
  return [...value];
}

// dist/web/create-worker-host-runtime.js
var import_meta = {};
function debugLoggingEnabled(state) {
  return state.logLevel === "debug" || state.logLevel === "trace";
}
var nextDisconnectRequestId = 0;
var nextPermissionAuthorizationRequestId = 0;
var nextSessionChatIdentityKeyRequestId = 0;
var nextDeviceStatementKeyRequestId = 0;
var nextDeviceEncryptionKeyRequestId = 0;
var nextProductSubtreePublicKeyRequestId = 0;
var nextSessionActivationRequestId = 0;
var nextLocalIdentityRequestId = 0;
var nextAllowanceSnapshotRequestId = 0;
var nextActionRequestId = 0;
var nextRenderId = 0;
function encodePermissionAuthorizationRequest(request) {
  return PermissionAuthorizationRequest.enc(request);
}
var DEV_LOG_LEVEL_KEY = "truapi:logLevel";
function readPersistedLogLevel() {
  return globalThis.localStorage?.getItem(DEV_LOG_LEVEL_KEY) ?? null;
}
var DEV_DEBUGGER_URL_KEY = "truapi:debugger";
function readPersistedDebuggerUrl() {
  let dev = false;
  try {
    dev = import_meta.env.DEV === true;
  } catch {
    dev = false;
  }
  if (!dev) {
    let switchSet = false;
    try {
      const key = globalThis.localStorage?.getItem(DEV_DEBUGGER_URL_KEY);
      switchSet = key !== null && key !== void 0 && key !== "";
    } catch {
      switchSet = false;
    }
    return {
      url: null,
      reason: switchSet ? "production-build-switch-set" : "production-build"
    };
  }
  const storage = globalThis.localStorage;
  if (storage === void 0)
    return { url: null, reason: "no-storage" };
  const url = storage.getItem(DEV_DEBUGGER_URL_KEY);
  if (url === null || url === "")
    return { url: null, reason: "no-key" };
  return { url, reason: "enabled" };
}
function reportDebuggerEnablement(e) {
  if (e.reason === "production-build")
    return;
  if (e.reason === "production-build-switch-set") {
    console.info(`[truapi] wire debugger: off (the "${DEV_DEBUGGER_URL_KEY}" switch is set, but \`import.meta.env.DEV\` did not resolve true, so the dial is compiled out. Either this is a production build - rebuild the host in dev mode - or the bundler did not substitute that token.`);
    return;
  }
  const origin = globalThis.location?.origin ?? "(unknown origin)";
  if (e.reason === "enabled") {
    console.info(`[truapi] wire debugger: dialling ${e.url} (origin ${origin})`);
    return;
  }
  const why = e.reason === "no-storage" ? "no localStorage in this realm" : `no "${DEV_DEBUGGER_URL_KEY}" key on origin ${origin} - localStorage is per-origin, so set it on THIS origin (the realm that creates the host runtime), then reload. A key on another origin is invisible here`;
  console.info(`[truapi] wire debugger: off (${why})`);
}
function persistLogLevel(level) {
  globalThis.localStorage?.setItem(DEV_LOG_LEVEL_KEY, level);
}
var devLogLevelOverride = readPersistedLogLevel();
var devGlobalTargets = /* @__PURE__ */ new Set();
var NATIVE_CHAT_FILE_CALLBACKS = {
  pickChatFiles: true,
  readChatFile: true,
  releaseChatFile: true,
  beginChatFileExport: true,
  writeChatFileExport: true,
  finishChatFileExport: true,
  cancelChatFileExport: true
};
async function discardChatFileCallback(state, name, value) {
  try {
    if (name === "pickChatFiles" && value instanceof Uint8Array) {
      await Promise.all((0, import_scale3.Vector)(NativeChatPickedFile).dec(value).map((file) => state.rawCallbacks.releaseChatFile(file.sourceId)));
    } else if (name === "beginChatFileExport" && typeof value === "string") {
      state.chatFileExports.delete(value);
      await state.rawCallbacks.cancelChatFileExport(value);
    }
  } catch {
  }
}
function operationIdFrom(value) {
  if (!(value instanceof Uint8Array))
    return null;
  try {
    return import_truapi3.HostWorkerBeginOperationResponse.dec(value).id;
  } catch {
    return null;
  }
}
function operationHold(encodedProduct, id) {
  if (!(encodedProduct instanceof Uint8Array))
    return null;
  try {
    return `${ProductContext.dec(encodedProduct).productId}\0${id}`;
  } catch {
    return null;
  }
}
function handleCallbackRequest(state, msg) {
  if (state.disposed)
    return;
  const hostWalletCallback = COINAGE_WALLET_CALLBACKS[msg.name] === true;
  const callbacks = msg.coreId === void 0 || hostWalletCallback ? state.rawCallbacks : state.coreCallbacks.get(msg.coreId);
  const fn = callbacks && Object.hasOwn(callbacks, msg.name) ? callbacks[msg.name] : void 0;
  if (!fn) {
    state.worker.postMessage({
      kind: "callbackResponse",
      requestId: msg.requestId,
      ok: false,
      error: `unknown callback: ${msg.name}`
    });
    return;
  }
  Promise.resolve().then(() => {
    if (state.disposed)
      throw new Error("Host runtime is unavailable");
    if (!hostWalletCallback && msg.coreId !== void 0 && !state.coreCallbacks.has(msg.coreId))
      throw new Error("Product callbacks are unavailable");
    return fn(...msg.args);
  }).then(async (value) => {
    if (state.disposed) {
      await discardChatFileCallback(state, msg.name, value);
      return;
    }
    if (msg.name === "beginOperation") {
      const id = operationIdFrom(value);
      const hold = id === null ? null : operationHold(msg.args[0], id);
      if (hold !== null)
        state.openOperations.add(hold);
    } else if (msg.name === "endOperation") {
      const id = msg.args[1];
      const hold = typeof id === "number" ? operationHold(msg.args[0], id) : null;
      if (hold !== null)
        state.openOperations.delete(hold);
      if (state.openOperations.size === 0 && state.disposePending) {
        state.disposePending = false;
        clearDisposeGrace(state);
        teardown(state, new Error("runtime disposed"), false);
      }
    }
    if (msg.name === "beginChatFileExport" && typeof value === "string") {
      state.chatFileExports.add(value);
    } else if (msg.name === "finishChatFileExport" || msg.name === "cancelChatFileExport") {
      state.chatFileExports.delete(msg.args[0]);
    }
    try {
      state.worker.postMessage({
        kind: "callbackResponse",
        requestId: msg.requestId,
        ok: true,
        value
      });
    } catch {
      await discardChatFileCallback(state, msg.name, value);
      if (state.disposed)
        return;
      try {
        state.worker.postMessage({
          kind: "callbackResponse",
          requestId: msg.requestId,
          ok: false,
          error: "Host callback result could not be serialized"
        });
      } catch {
        teardown(state, new Error("Host callback transport is unavailable"), true);
      }
    }
  }, (err2) => {
    if (state.disposed)
      return;
    try {
      state.worker.postMessage({
        kind: "callbackResponse",
        requestId: msg.requestId,
        ok: false,
        error: hostWalletCallback ? "Native Coinage wallet operation failed" : NATIVE_CHAT_FILE_CALLBACKS[msg.name] ? "Native Chat file operation failed" : errorMessage(err2)
      });
    } catch {
      teardown(state, new Error("Host callback transport is unavailable"), true);
    }
  });
}
function handleSubscriptionStart(state, msg) {
  const sendItem = (value) => {
    if (state.disposed)
      return;
    state.worker.postMessage({
      kind: "subscriptionItem",
      subId: msg.subId,
      value
    });
  };
  const sendError = (error) => {
    if (state.disposed)
      return;
    state.worker.postMessage({
      kind: "subscriptionError",
      subId: msg.subId,
      error: error.reason
    });
  };
  let dispose = void 0;
  try {
    const callbacks = msg.coreId === void 0 ? state.rawCallbacks : state.coreCallbacks.get(msg.coreId);
    if (!callbacks)
      throw new Error("Product callbacks are unavailable");
    dispose = startRawSubscription(callbacks, msg.name, msg.payload, sendItem, sendError);
  } catch (err2) {
    sendError({ reason: errorMessage(err2) });
    return;
  }
  if (typeof dispose === "function") {
    state.subscriptionDisposers.set(msg.subId, dispose);
  }
}
function handleSubscriptionStop(state, msg) {
  const dispose = state.subscriptionDisposers.get(msg.subId);
  if (!dispose)
    return;
  state.subscriptionDisposers.delete(msg.subId);
  try {
    dispose();
  } catch (err2) {
    console.warn("[truapi worker] subscription dispose threw:", err2);
  }
}
async function handleChainConnectStart(state, msg) {
  if (state.disposed)
    return;
  if (state.chainConnections.has(msg.connId) || state.chainConnections.size >= MAX_JSON_RPC_CONNECTIONS) {
    state.worker.postMessage({
      kind: "chainConnectAck",
      connId: msg.connId,
      ok: false,
      error: "JSON-RPC connection limit reached or duplicate connection id"
    });
    return;
  }
  const entry = { connection: null, closed: false };
  state.chainConnections.set(msg.connId, entry);
  const onResponse = (json) => {
    if (state.disposed || entry.closed)
      return;
    state.worker.postMessage({
      kind: "chainResponse",
      connId: msg.connId,
      json
    });
  };
  const onClosed = () => {
    if (state.disposed || entry.closed)
      return;
    handleChainClose(state, msg);
    state.worker.postMessage({
      kind: "chainClosed",
      connId: msg.connId
    });
  };
  try {
    const conn = await (msg.kind === "hopConnectStart" ? state.rawCallbacks.hopConnect(msg.genesisHash, msg.endpoint, onResponse, onClosed) : state.rawCallbacks.chainConnect(msg.genesisHash, onResponse, onClosed));
    if (state.disposed || entry.closed) {
      state.chainConnections.delete(msg.connId);
      conn?.close();
      return;
    }
    if (!conn)
      throw new Error(`${msg.kind} returned no connection`);
    entry.connection = conn;
    state.worker.postMessage({
      kind: "chainConnectAck",
      connId: msg.connId,
      ok: true
    });
  } catch (err2) {
    state.chainConnections.delete(msg.connId);
    const report = !state.disposed && !entry.closed;
    entry.closed = true;
    try {
      entry.connection?.close();
    } catch {
      console.warn("[truapi worker] JSON-RPC close failed");
    } finally {
      if (report) {
        state.worker.postMessage({
          kind: "chainConnectAck",
          connId: msg.connId,
          ok: false,
          error: msg.kind === "hopConnectStart" ? "HOP connection unavailable" : errorMessage(err2)
        });
      }
    }
  }
}
function handleChainSend(state, msg) {
  const entry = state.chainConnections.get(msg.connId);
  if (!entry?.connection || entry.closed)
    return;
  try {
    if (debugLoggingEnabled(state)) {
      console.debug("[truapi worker] chainSend", msg.connId);
    }
    entry.connection.send(msg.request);
  } catch {
    console.warn("[truapi worker] JSON-RPC send failed");
    if (!entry.closed) {
      handleChainClose(state, msg);
      if (!state.disposed) {
        state.worker.postMessage({
          kind: "chainClosed",
          connId: msg.connId
        });
      }
    }
  }
}
function handleChainClose(state, msg) {
  const entry = state.chainConnections.get(msg.connId);
  if (!entry || entry.closed)
    return;
  entry.closed = true;
  if (!entry.connection)
    return;
  state.chainConnections.delete(msg.connId);
  try {
    entry.connection.close();
  } catch {
    console.warn("[truapi worker] JSON-RPC close failed");
  }
}
function settlePending(map, requestId, result) {
  const pending = map.get(requestId);
  if (!pending)
    return;
  map.delete(requestId);
  if (result.ok)
    pending.resolve(result.value);
  else
    pending.reject(new Error(result.error));
}
function rejectAll(map, error) {
  for (const pending of map.values()) {
    pending.reject(error);
  }
  map.clear();
}
function handleDisconnectResponse(state, msg) {
  settlePending(state.pendingDisconnects, msg.requestId, msg.ok ? { ok: true, value: void 0 } : { ok: false, error: msg.error });
}
function handleSessionActivationResponse(state, msg) {
  settlePending(state.pendingSessionActivations, msg.requestId, msg.ok ? { ok: true, value: void 0 } : { ok: false, error: msg.error });
}
function handlePermissionAuthorizationStatusResponse(state, msg) {
  settlePending(state.pendingPermissionAuthorizationStatuses, msg.requestId, msg.ok ? { ok: true, value: msg.status } : { ok: false, error: msg.error });
}
function handlePermissionAuthorizationStatusesResponse(state, msg) {
  settlePending(state.pendingPermissionAuthorizationStatusBatches, msg.requestId, msg.ok ? { ok: true, value: msg.statuses } : { ok: false, error: msg.error });
}
function handleSetPermissionAuthorizationStatusResponse(state, msg) {
  settlePending(state.pendingSetPermissionAuthorizationStatuses, msg.requestId, msg.ok ? { ok: true, value: void 0 } : { ok: false, error: msg.error });
}
function handleSessionChatIdentityKeyResponse(state, msg) {
  settlePending(state.pendingSessionChatIdentityKeys, msg.requestId, msg.ok ? { ok: true, value: msg.key } : { ok: false, error: msg.error });
}
function handleDeviceStatementKeyResponse(state, msg) {
  settlePending(state.pendingDeviceStatementKeys, msg.requestId, msg.ok ? { ok: true, value: msg.key } : { ok: false, error: msg.error });
}
function handleProductSubtreePublicKeyResponse(state, msg) {
  settlePending(state.pendingProductSubtreePublicKeys, msg.requestId, msg.ok ? { ok: true, value: msg.key } : { ok: false, error: msg.error });
}
function handleDeviceEncryptionKeyResponse(state, msg) {
  settlePending(state.pendingDeviceEncryptionKeys, msg.requestId, msg.ok ? { ok: true, value: msg.key } : { ok: false, error: msg.error });
}
function rejectPendingRuntimeRequests(state, error) {
  rejectAll(state.pendingDisconnects, error);
  rejectAll(state.pendingSessionActivations, error);
  rejectAll(state.pendingLocalIdentities, error);
  rejectAll(state.pendingAllowanceSnapshots, error);
  rejectAll(state.pendingPermissionAuthorizationStatuses, error);
  rejectAll(state.pendingPermissionAuthorizationStatusBatches, error);
  rejectAll(state.pendingSetPermissionAuthorizationStatuses, error);
  rejectAll(state.pendingSessionChatIdentityKeys, error);
  rejectAll(state.pendingDeviceStatementKeys, error);
  rejectAll(state.pendingDeviceEncryptionKeys, error);
  rejectAll(state.pendingProductSubtreePublicKeys, error);
  rejectAll(state.pendingActions, error);
  for (const renderId of [...state.renders.keys()]) {
    const sink = takeRender(state, renderId);
    if (sink)
      reportRenderFailure(sink, error);
  }
  for (const pending of state.pendingCores.values()) {
    pending.reject(error);
  }
  state.pendingCores.clear();
}
function sendWorkerRequest(state, pending, nextId, disposedFallback, buildMessage) {
  if (state.disposed)
    return Promise.resolve(disposedFallback);
  return new Promise((resolve, reject) => {
    const requestId = nextId();
    pending.set(requestId, { resolve, reject });
    try {
      state.worker.postMessage(buildMessage(requestId));
    } catch (err2) {
      pending.delete(requestId);
      reject(err2 instanceof Error ? err2 : new Error(String(err2)));
    }
  });
}
function sendSessionActivationRequest(state, buildMessage, changesIdentity = true) {
  if (state.disposed) {
    return Promise.reject(state.closedError ?? new Error("runtime disposed"));
  }
  if (changesIdentity)
    invalidateAllowanceIdentity(state);
  return sendWorkerRequest(state, state.pendingSessionActivations, () => ++nextSessionActivationRequestId, void 0, buildMessage);
}
function sendLocalIdentityRequest(state, buildMessage, onProgress) {
  if (state.disposed) {
    return Promise.reject(state.closedError ?? new Error("runtime disposed"));
  }
  const generation = state.identityGeneration;
  const { promise, resolve, reject } = Promise.withResolvers();
  const requestId = ++nextLocalIdentityRequestId;
  state.pendingLocalIdentities.set(requestId, {
    resolve(identity) {
      if (generation !== state.identityGeneration || state.disposePending) {
        reject(new Error("local identity activation changed"));
        return;
      }
      state.identityAccountId = identity.identityAccountId;
      resolve(identity);
    },
    reject,
    onProgress
  });
  try {
    state.worker.postMessage(buildMessage(requestId));
  } catch (error) {
    state.pendingLocalIdentities.delete(requestId);
    reject(error);
  }
  return promise;
}
function invalidateAllowanceIdentity(state) {
  state.identityGeneration++;
  state.identityAccountId = null;
  rejectAll(state.pendingAllowanceSnapshots, new Error("local identity activation changed"));
}
async function getWalletAllowanceSnapshot(state, input) {
  if (state.disposed || state.disposePending) {
    throw state.closedError ?? new Error("runtime disposed");
  }
  if (state.role !== "signing" || state.pendingSessionActivations.size > 0 || state.pendingDisconnects.size > 0) {
    throw new Error("allowance inspection requires a current local signing identity");
  }
  const productIds = validateAllowanceProductIds(input);
  const accountId = state.identityAccountId;
  const generation = state.identityGeneration;
  const requestId = ++nextAllowanceSnapshotRequestId;
  const { promise, resolve, reject } = Promise.withResolvers();
  const timeout = setTimeout(() => {
    state.pendingAllowanceSnapshots.delete(requestId);
    reject(new Error("wallet allowance inspection timed out after 30000ms"));
  }, 3e4);
  state.pendingAllowanceSnapshots.set(requestId, {
    resolve(snapshot) {
      clearTimeout(timeout);
      if (generation !== state.identityGeneration || snapshot?.schemaVersion !== 1 || accountId !== null && snapshot.identityAccountId !== accountId || snapshot.networkSuffix !== state.networkSuffix) {
        reject(new Error("wallet allowance snapshot does not match the current identity"));
        return;
      }
      resolve(snapshot);
    },
    reject(error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
  try {
    state.worker.postMessage({
      kind: "getWalletAllowanceSnapshot",
      requestId,
      productIds
    });
  } catch (error) {
    settlePending(state.pendingAllowanceSnapshots, requestId, {
      ok: false,
      error: errorMessage(error)
    });
  }
  return promise;
}
function closeCoreState(core, error) {
  if (core.disposed)
    return;
  core.disposed = true;
  core.closedError = error;
  for (const listener of [...core.closeListeners])
    listener(error);
  core.listeners.clear();
  core.closeListeners.clear();
}
function clearDisposeGrace(state) {
  if (state.disposeGraceTimer === void 0)
    return;
  clearTimeout(state.disposeGraceTimer);
  state.disposeGraceTimer = void 0;
}
function teardown(state, error, fault) {
  if (state.disposed)
    return;
  state.disposed = true;
  clearDisposeGrace(state);
  state.closedError = error;
  rejectPendingRuntimeRequests(state, error);
  for (const core of state.cores.values()) {
    closeCoreState(core, error);
  }
  state.cores.clear();
  state.coreCallbacks.clear();
  for (const fn of state.subscriptionDisposers.values()) {
    try {
      fn();
    } catch {
    }
  }
  state.subscriptionDisposers.clear();
  for (const entry of state.chainConnections.values()) {
    entry.closed = true;
    try {
      entry.connection?.close();
    } catch {
    }
  }
  state.chainConnections.clear();
  for (const id of state.chatFileExports) {
    void state.rawCallbacks.cancelChatFileExport(id).catch(() => {
    });
  }
  state.chatFileExports.clear();
  state.disposeNativeChatFiles();
  for (const productId of [...state.wantedWorkers]) {
    handleWorkerDemandChanged(state, productId, false);
  }
  state.workerDemandListeners.clear();
  if (fault) {
    state.worker.terminate();
  } else {
    try {
      state.worker.postMessage({ kind: "dispose" });
    } catch {
    }
    setTimeout(() => state.worker.terminate(), 0);
  }
}
function createWebWorkerSigningHostRuntime(worker, host, options) {
  return createWebWorkerHostRuntime(worker, host, {
    ...options,
    role: options.role ?? "signing"
  });
}
function createWebWorkerHostRuntime(worker, host, options) {
  const browserFiles = host.nativeChatFiles ? void 0 : createBrowserNativeChatFilesHost();
  const callbacks = createWasmRawCallbacks({
    ...host,
    nativeChatFiles: host.nativeChatFiles ?? browserFiles
  });
  return new Promise((resolve, reject) => {
    const state = {
      worker,
      role: options.role ?? "pairing",
      networkSuffix: "networkSuffix" in options.hostConfig ? options.hostConfig.networkSuffix : void 0,
      identityAccountId: null,
      identityGeneration: 0,
      pendingAllowanceSnapshots: /* @__PURE__ */ new Map(),
      rawCallbacks: callbacks,
      coreCallbacks: /* @__PURE__ */ new Map(),
      cores: /* @__PURE__ */ new Map(),
      pendingCores: /* @__PURE__ */ new Map(),
      subscriptionDisposers: /* @__PURE__ */ new Map(),
      openOperations: /* @__PURE__ */ new Set(),
      disposePending: false,
      disposeGraceTimer: void 0,
      operationGraceMs: options.operationGraceMs ?? 3e4,
      chainConnections: /* @__PURE__ */ new Map(),
      chatFileExports: /* @__PURE__ */ new Set(),
      disposeNativeChatFiles: () => browserFiles?.dispose(),
      pendingDisconnects: /* @__PURE__ */ new Map(),
      pendingSessionActivations: /* @__PURE__ */ new Map(),
      pendingLocalIdentities: /* @__PURE__ */ new Map(),
      pendingPermissionAuthorizationStatuses: /* @__PURE__ */ new Map(),
      pendingPermissionAuthorizationStatusBatches: /* @__PURE__ */ new Map(),
      pendingSetPermissionAuthorizationStatuses: /* @__PURE__ */ new Map(),
      pendingSessionChatIdentityKeys: /* @__PURE__ */ new Map(),
      pendingProductSubtreePublicKeys: /* @__PURE__ */ new Map(),
      pendingDeviceStatementKeys: /* @__PURE__ */ new Map(),
      pendingDeviceEncryptionKeys: /* @__PURE__ */ new Map(),
      pendingActions: /* @__PURE__ */ new Map(),
      renders: /* @__PURE__ */ new Map(),
      wantedWorkers: /* @__PURE__ */ new Set(),
      workerDemandListeners: /* @__PURE__ */ new Set(),
      closedError: null,
      logLevel: devLogLevelOverride ?? options.logLevel ?? "off",
      disposed: false,
      nextCoreId: 0,
      coreWireSchemaHash: void 0
    };
    let runtime = null;
    const notifyFault = (error) => {
      teardown(state, error, true);
    };
    const onMessage = (ev) => {
      const msg = ev.data;
      switch (msg.kind) {
        case "loaded":
        case "ready":
          break;
        case "coreReady":
          handleCoreReady(state, msg.coreId, runtime);
          break;
        case "coreError":
          handleCoreError(state, msg.coreId, msg.error);
          break;
        case "fatalError":
          console.error("[truapi worker]", msg.error);
          notifyFault(new Error(`worker fatal error: ${msg.error}`));
          break;
        case "frameError":
          handleFrameError(state, msg.coreId, msg.error);
          break;
        case "disposeError":
          console.warn("[truapi worker] dispose:", msg.error);
          break;
        case "frame": {
          const core = state.cores.get(msg.coreId);
          if (!core || core.disposed)
            break;
          if (debugLoggingEnabled(state)) {
            console.debug("[truapi worker] frame <-", (0, import_scale3.bytesToHex)(msg.bytes));
          }
          for (const listener of [...core.listeners])
            listener(msg.bytes);
          break;
        }
        case "disconnectSessionResponse":
          handleDisconnectResponse(state, msg);
          break;
        case "sessionActivationResponse":
          handleSessionActivationResponse(state, msg);
          break;
        case "localIdentityProgress":
          if (state.disposed)
            break;
          try {
            state.pendingLocalIdentities.get(msg.requestId)?.onProgress?.(msg.progress);
          } catch {
          }
          break;
        case "localIdentityResponse":
          settlePending(state.pendingLocalIdentities, msg.requestId, msg.ok ? { ok: true, value: msg.identity } : { ok: false, error: msg.error });
          break;
        case "walletAllowanceSnapshotResponse":
          settlePending(state.pendingAllowanceSnapshots, msg.requestId, msg.ok ? { ok: true, value: msg.snapshot } : { ok: false, error: msg.error });
          break;
        case "permissionAuthorizationStatusResponse":
          handlePermissionAuthorizationStatusResponse(state, msg);
          break;
        case "permissionAuthorizationStatusesResponse":
          handlePermissionAuthorizationStatusesResponse(state, msg);
          break;
        case "setPermissionAuthorizationStatusResponse":
          handleSetPermissionAuthorizationStatusResponse(state, msg);
          break;
        case "sessionChatIdentityKeyResponse":
          handleSessionChatIdentityKeyResponse(state, msg);
          break;
        case "deviceStatementKeyResponse":
          handleDeviceStatementKeyResponse(state, msg);
          break;
        case "deviceEncryptionKeyResponse":
          handleDeviceEncryptionKeyResponse(state, msg);
          break;
        case "productSubtreePublicKeyResponse":
          handleProductSubtreePublicKeyResponse(state, msg);
          break;
        case "workerDemandChanged":
          if (!state.disposed) {
            handleWorkerDemandChanged(state, msg.productId, msg.wanted);
          }
          break;
        case "publishChatActionResponse":
        case "publishRendererActionResponse":
          settlePending(state.pendingActions, msg.requestId, msg.ok ? { ok: true, value: void 0 } : { ok: false, error: msg.error });
          break;
        case "renderItem": {
          const sink = state.renders.get(msg.renderId);
          if (!sink)
            break;
          try {
            sink.onUpdate(import_truapi3.RendererNode.dec(msg.node));
          } catch (err2) {
            takeRender(state, msg.renderId);
            state.worker.postMessage({
              kind: "renderStop",
              renderId: msg.renderId
            });
            reportRenderFailure(sink, err2);
          }
          break;
        }
        case "renderComplete": {
          const sink = takeRender(state, msg.renderId);
          try {
            sink?.onComplete();
          } catch (err2) {
            console.warn("[truapi worker] render onComplete threw:", err2);
          }
          break;
        }
        case "renderError": {
          const sink = takeRender(state, msg.renderId);
          if (sink)
            reportRenderFailure(sink, new Error(msg.error));
          break;
        }
        case "callbackRequest":
          if (debugLoggingEnabled(state)) {
            console.debug("[truapi worker] callbackRequest", msg.name);
          }
          handleCallbackRequest(state, msg);
          break;
        case "subscriptionStart":
          handleSubscriptionStart(state, msg);
          break;
        case "subscriptionStop":
          handleSubscriptionStop(state, msg);
          break;
        case "chainConnectStart":
        case "hopConnectStart":
          if (debugLoggingEnabled(state)) {
            console.debug("[truapi worker]", msg.kind, msg.connId);
          }
          void handleChainConnectStart(state, msg);
          break;
        case "chainSend":
          handleChainSend(state, msg);
          break;
        case "chainClose":
          handleChainClose(state, msg);
          break;
        default: {
          const { kind } = msg;
          console.warn(`[truapi worker] unknown worker message kind: ${String(kind)}`);
        }
      }
    };
    const onError = (e) => {
      cleanupInit();
      worker.terminate();
      reject(new Error(`worker init failed: ${e.message}`));
    };
    const onInitMessageError = () => {
      cleanupInit();
      worker.terminate();
      reject(new Error("worker message could not be deserialized during init"));
    };
    const onRuntimeError = (e) => {
      console.error("[truapi worker]", e.message);
      notifyFault(new Error(`worker error: ${e.message}`));
    };
    const onMessageError = () => {
      notifyFault(new Error("worker message could not be deserialized"));
    };
    const debuggerEnablement = readPersistedDebuggerUrl();
    reportDebuggerEnablement(debuggerEnablement);
    const onInitMessage = (ev) => {
      const msg = ev.data;
      if (msg.kind === "loaded") {
        worker.postMessage({
          kind: "init",
          logLevel: devLogLevelOverride ?? options.logLevel ?? "off",
          hostConfig: options.hostConfig,
          role: options.role,
          capabilities: {
            chat: host.chat !== void 0,
            permissionStatus: host.permissionStatus !== void 0,
            pocket: host.pocket !== void 0,
            profile: host.profile !== void 0,
            identityBackend: host.identityBackend !== void 0,
            coinageWallet: callbacks.nativeCoinage !== void 0
          },
          debuggerUrl: debuggerEnablement.url
        });
      } else if (msg.kind === "ready") {
        state.coreWireSchemaHash = msg.schema;
        cleanupInit();
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onRuntimeError);
        worker.addEventListener("messageerror", onMessageError);
        runtime = buildRuntime(state);
        exposeDevGlobal(runtime);
        resolve(runtime);
      } else if (msg.kind === "fatalError") {
        cleanupInit();
        worker.terminate();
        reject(new Error(`worker init reported error: ${msg.error}`));
      }
    };
    const cleanupInit = () => {
      clearTimeout(initTimeout);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onInitMessageError);
      worker.removeEventListener("message", onInitMessage);
    };
    const timeoutMs = options.initTimeoutMs ?? 3e4;
    const initTimeout = setTimeout(() => {
      cleanupInit();
      worker.terminate();
      reject(new Error(`worker init timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onInitMessageError);
    worker.addEventListener("message", onInitMessage);
  });
}
function handleCoreReady(state, coreId, runtime) {
  const pending = state.pendingCores.get(coreId);
  if (!pending || !runtime)
    return;
  state.pendingCores.delete(coreId);
  const core = {
    coreId,
    productId: pending.productId,
    listeners: /* @__PURE__ */ new Set(),
    closeListeners: /* @__PURE__ */ new Set(),
    closedError: null,
    disposed: false
  };
  state.cores.set(coreId, core);
  pending.resolve(buildProvider(state, core, runtime));
}
function handleCoreError(state, coreId, error) {
  const pending = state.pendingCores.get(coreId);
  if (!pending)
    return;
  state.pendingCores.delete(coreId);
  state.coreCallbacks.delete(coreId);
  pending.reject(new Error(error));
}
function handleFrameError(state, coreId, error) {
  console.error("[truapi worker]", error);
  const core = state.cores.get(coreId);
  if (!core)
    return;
  const failure = new Error(`worker frame error: ${error}`);
  closeCoreState(core, failure);
  state.cores.delete(coreId);
  state.coreCallbacks.delete(coreId);
  failRendersForCore(state, coreId, failure);
  try {
    state.worker.postMessage({
      kind: "disposeCore",
      coreId
    });
  } catch {
  }
}
function buildRuntime(state) {
  const runtime = {
    coreWireSchemaHash: state.coreWireSchemaHash,
    createProvider(product, callbacks) {
      if (state.disposed) {
        return Promise.reject(state.closedError ?? new Error("runtime disposed"));
      }
      return new Promise((resolve, reject) => {
        const coreId = ++state.nextCoreId;
        if (callbacks)
          state.coreCallbacks.set(coreId, createWasmRawCallbacks(callbacks));
        state.pendingCores.set(coreId, {
          productId: product.productId,
          resolve,
          reject
        });
        try {
          state.worker.postMessage({
            kind: "createCore",
            coreId,
            product,
            ...callbacks === void 0 ? {} : {
              capabilities: {
                chat: callbacks.chat !== void 0,
                permissionStatus: callbacks.permissionStatus !== void 0,
                pocket: callbacks.pocket !== void 0,
                profile: callbacks.profile !== void 0,
                identityBackend: callbacks.identityBackend !== void 0,
                coinageWallet: state.rawCallbacks.nativeCoinage !== void 0
              }
            }
          });
        } catch (err2) {
          state.pendingCores.delete(coreId);
          state.coreCallbacks.delete(coreId);
          reject(err2 instanceof Error ? err2 : new Error(String(err2)));
        }
      });
    },
    disconnectSession() {
      invalidateAllowanceIdentity(state);
      return sendWorkerRequest(state, state.pendingDisconnects, () => ++nextDisconnectRequestId, void 0, (requestId) => ({ kind: "disconnectSession", requestId }));
    },
    cancelPairing() {
      if (state.disposed)
        return;
      state.worker.postMessage({
        kind: "cancelPairing"
      });
    },
    getSessionChatIdentityKey() {
      return sendWorkerRequest(state, state.pendingSessionChatIdentityKeys, () => ++nextSessionChatIdentityKeyRequestId, void 0, (requestId) => ({ kind: "getSessionChatIdentityKey", requestId }));
    },
    getDeviceStatementKey() {
      return sendWorkerRequest(state, state.pendingDeviceStatementKeys, () => ++nextDeviceStatementKeyRequestId, void 0, (requestId) => ({ kind: "getDeviceStatementKey", requestId }));
    },
    getDeviceEncryptionKey() {
      if (state.disposed) {
        return Promise.reject(new Error("worker host runtime is disposed"));
      }
      return sendWorkerRequest(state, state.pendingDeviceEncryptionKeys, () => ++nextDeviceEncryptionKeyRequestId, new Uint8Array(), (requestId) => ({ kind: "getDeviceEncryptionKey", requestId }));
    },
    getProductSubtreePublicKey(productId, timeoutMs) {
      return sendWorkerRequest(state, state.pendingProductSubtreePublicKeys, () => ++nextProductSubtreePublicKeyRequestId, void 0, (requestId) => ({
        kind: "getProductSubtreePublicKey",
        requestId,
        productId,
        timeoutMs
      }));
    },
    notifySessionStoreChanged() {
      if (state.disposed)
        return;
      state.worker.postMessage({
        kind: "notifySessionStoreChanged"
      });
    },
    acquireWorker(productId) {
      postUnlessDisposed(state, { kind: "acquireWorker", productId });
    },
    releaseWorker(productId) {
      postUnlessDisposed(state, { kind: "releaseWorker", productId });
    },
    subscribeWorkerDemand(listener) {
      if (state.disposed)
        return () => {
        };
      state.workerDemandListeners.add(listener);
      for (const productId of state.wantedWorkers) {
        deliverWorkerDemand(listener, { productId, wanted: true });
      }
      return () => {
        state.workerDemandListeners.delete(listener);
      };
    },
    activateStoredSession() {
      return sendSessionActivationRequest(state, (requestId) => ({
        kind: "activateStoredSession",
        requestId
      }));
    },
    activateExternalSession(blob) {
      return sendSessionActivationRequest(state, (requestId) => ({
        kind: "activateExternalSession",
        requestId,
        blob
      }));
    },
    activateLocalSession(secret, liteUsername) {
      return sendSessionActivationRequest(state, (requestId) => ({
        kind: "activateLocalSession",
        requestId,
        secret,
        liteUsername
      }));
    },
    setGrantAllowancesUnchecked(granted) {
      return sendSessionActivationRequest(state, (requestId) => ({
        kind: "setGrantAllowancesUnchecked",
        requestId,
        granted
      }), false);
    },
    resetSessionState() {
      return sendSessionActivationRequest(state, (requestId) => ({
        kind: "resetSessionState",
        requestId
      }));
    },
    activateLocalSessionWithIdentity(secret, liteUsername) {
      return sendSessionActivationRequest(state, (requestId) => ({
        kind: "activateLocalSessionWithIdentity",
        requestId,
        secret,
        liteUsername
      }));
    },
    refreshLocalIdentity() {
      return sendLocalIdentityRequest(state, (requestId) => ({
        kind: "refreshLocalIdentity",
        requestId
      }));
    },
    getWalletAllowanceSnapshot(productIds) {
      return getWalletAllowanceSnapshot(state, productIds);
    },
    registerLocalLiteUsername(baseUsername, identityBackendBaseUrl, onProgress) {
      return sendLocalIdentityRequest(state, (requestId) => ({
        kind: "registerLocalLiteUsername",
        requestId,
        baseUsername,
        identityBackendBaseUrl
      }), onProgress);
    },
    getPermissionAuthorizationStatus(productId, request) {
      return sendWorkerRequest(state, state.pendingPermissionAuthorizationStatuses, () => ++nextPermissionAuthorizationRequestId, "NotDetermined", (requestId) => ({
        kind: "getPermissionAuthorizationStatus",
        productId,
        requestId,
        request: encodePermissionAuthorizationRequest(request)
      }));
    },
    getPermissionAuthorizationStatuses(productId, requests) {
      return sendWorkerRequest(state, state.pendingPermissionAuthorizationStatusBatches, () => ++nextPermissionAuthorizationRequestId, requests.map(() => "NotDetermined"), (requestId) => ({
        kind: "getPermissionAuthorizationStatuses",
        productId,
        requestId,
        requests: requests.map(encodePermissionAuthorizationRequest)
      }));
    },
    setPermissionAuthorizationStatus(productId, request, status) {
      return sendWorkerRequest(state, state.pendingSetPermissionAuthorizationStatuses, () => ++nextPermissionAuthorizationRequestId, void 0, (requestId) => ({
        kind: "setPermissionAuthorizationStatus",
        productId,
        requestId,
        request: encodePermissionAuthorizationRequest(request),
        status
      }));
    },
    setLogLevel(level) {
      if (state.disposed)
        return;
      state.logLevel = level;
      state.worker.postMessage({
        kind: "setLogLevel",
        level
      });
    },
    dispose() {
      invalidateAllowanceIdentity(state);
      devGlobalTargets.delete(runtime);
      if (state.openOperations.size > 0) {
        state.disposePending = true;
        state.disposeGraceTimer ??= setTimeout(() => {
          state.disposeGraceTimer = void 0;
          if (!state.disposePending)
            return;
          state.disposePending = false;
          teardown(state, new Error("runtime disposed"), false);
        }, state.operationGraceMs);
        return;
      }
      teardown(state, new Error("runtime disposed"), false);
    }
  };
  return runtime;
}
function postUnlessDisposed(state, message) {
  if (state.disposed)
    return;
  state.worker.postMessage(message);
}
function deliverWorkerDemand(listener, change) {
  try {
    listener(change);
  } catch (err2) {
    console.warn("[truapi worker] worker demand listener threw:", err2);
  }
}
function handleWorkerDemandChanged(state, productId, wanted) {
  if (wanted)
    state.wantedWorkers.add(productId);
  else
    state.wantedWorkers.delete(productId);
  for (const listener of [...state.workerDemandListeners]) {
    if (!state.workerDemandListeners.has(listener))
      continue;
    deliverWorkerDemand(listener, { productId, wanted });
  }
}
function reportRenderFailure(sink, cause) {
  try {
    sink.onError?.(toError(cause));
  } catch (err2) {
    console.warn("[truapi worker] render onError threw:", err2);
  }
}
function takeRender(state, renderId) {
  const entry = state.renders.get(renderId);
  if (!entry)
    return void 0;
  state.renders.delete(renderId);
  return entry;
}
function failRendersForCore(state, coreId, error) {
  for (const [renderId, entry] of [...state.renders]) {
    if (entry.coreId !== coreId)
      continue;
    const sink = takeRender(state, renderId);
    if (sink)
      reportRenderFailure(sink, error);
  }
}
function publishAction(state, core, kind, encode) {
  if (state.disposed || core.disposed) {
    return Promise.reject(new Error("product connection is closed"));
  }
  let action;
  try {
    action = encode();
  } catch (err2) {
    return Promise.reject(toError(err2));
  }
  return sendWorkerRequest(state, state.pendingActions, () => nextActionRequestId++, void 0, (requestId) => ({ kind, coreId: core.coreId, requestId, action }));
}
function buildProvider(state, core, runtime) {
  const provider = {
    postMessage(bytes2) {
      if (state.disposed || core.disposed)
        return;
      if (debugLoggingEnabled(state)) {
        console.debug("[truapi worker] frame ->", (0, import_scale3.bytesToHex)(bytes2));
      }
      state.worker.postMessage({
        kind: "frame",
        coreId: core.coreId,
        bytes: bytes2
      });
    },
    subscribe(callback) {
      core.listeners.add(callback);
      return () => {
        core.listeners.delete(callback);
      };
    },
    subscribeClose(callback) {
      const closed = core.closedError ?? state.closedError;
      if (closed) {
        callback(closed);
        return () => {
        };
      }
      core.closeListeners.add(callback);
      return () => {
        core.closeListeners.delete(callback);
      };
    },
    disconnectSession() {
      if (core.disposed)
        return Promise.resolve();
      return runtime.disconnectSession();
    },
    async getSessionChatIdentityKey() {
      if (core.disposed)
        return void 0;
      const key = await runtime.getSessionChatIdentityKey();
      return key && (0, import_scale3.bytesToHex)(key);
    },
    async getDeviceStatementKey() {
      if (core.disposed)
        return void 0;
      return runtime.getDeviceStatementKey();
    },
    async getDeviceEncryptionKey() {
      if (core.disposed) {
        throw new Error("product connection is closed");
      }
      return (0, import_scale3.bytesToHex)(await runtime.getDeviceEncryptionKey());
    },
    async getProductSubtreePublicKey(productId, timeoutMs) {
      if (core.disposed)
        return void 0;
      const key = await runtime.getProductSubtreePublicKey(productId, timeoutMs);
      return key && (0, import_scale3.bytesToHex)(key);
    },
    getPermissionAuthorizationStatus(request) {
      if (core.disposed)
        return Promise.resolve("NotDetermined");
      return runtime.getPermissionAuthorizationStatus(core.productId, request);
    },
    getPermissionAuthorizationStatuses(requests) {
      if (core.disposed) {
        return Promise.resolve(requests.map(() => "NotDetermined"));
      }
      return runtime.getPermissionAuthorizationStatuses(core.productId, requests);
    },
    setPermissionAuthorizationStatus(request, status) {
      if (core.disposed) {
        return Promise.reject(core.closedError ?? new Error("product connection is closed"));
      }
      return runtime.setPermissionAuthorizationStatus(core.productId, request, status);
    },
    setLogLevel(level) {
      if (core.disposed)
        return;
      runtime.setLogLevel(level);
    },
    publishChatAction(action) {
      return publishAction(state, core, "publishChatAction", () => import_truapi3.HostChatActionSubscribeItem.enc(action));
    },
    publishRendererAction(item) {
      return publishAction(state, core, "publishRendererAction", () => import_truapi3.HostRendererActionSubscribeItem.enc(item));
    },
    render(request, sink) {
      if (state.disposed || core.disposed) {
        sink.onError?.(new Error("product connection is closed"));
        return () => {
        };
      }
      let encoded;
      try {
        encoded = import_truapi3.ProductRendererRenderRequest.enc(request);
      } catch (err2) {
        reportRenderFailure(sink, err2);
        return () => {
        };
      }
      const renderId = nextRenderId++;
      state.renders.set(renderId, {
        coreId: core.coreId,
        onUpdate: (node) => sink.onUpdate(node),
        onComplete: () => sink.onComplete?.(),
        onError: (error) => sink.onError?.(error)
      });
      try {
        state.worker.postMessage({
          kind: "renderStart",
          coreId: core.coreId,
          renderId,
          request: encoded
        });
      } catch (err2) {
        const failed = takeRender(state, renderId);
        if (failed)
          reportRenderFailure(failed, err2);
        return () => {
        };
      }
      return () => {
        if (!takeRender(state, renderId))
          return;
        state.worker.postMessage({
          kind: "renderStop",
          renderId
        });
      };
    },
    dispose() {
      if (core.disposed)
        return;
      closeCoreState(core, new Error("provider disposed"));
      state.cores.delete(core.coreId);
      state.coreCallbacks.delete(core.coreId);
      failRendersForCore(state, core.coreId, new Error("provider disposed"));
      state.worker.postMessage({
        kind: "disposeCore",
        coreId: core.coreId
      });
    }
  };
  return provider;
}
function exposeDevGlobal(target) {
  devGlobalTargets.add(target);
  if (devLogLevelOverride !== null) {
    target.setLogLevel?.(devLogLevelOverride);
  }
  publishDevGlobal();
}
function publishDevGlobal() {
  const target = globalThis;
  target.__truapi = {
    setLogLevel(level) {
      devLogLevelOverride = level;
      persistLogLevel(level);
      for (const provider of [...devGlobalTargets]) {
        provider.setLogLevel?.(level);
      }
      console.info(`[truapi worker] logLevel=${level}`);
    },
    getLogLevel() {
      return devLogLevelOverride;
    }
  };
}
publishDevGlobal();

// ../../../node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
function anumber(n, title = "") {
  if (typeof n !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(`${prefix}expected number, got ${typeof n}`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    const prefix = title && `"${title}" `;
    throw new RangeError(`${prefix}expected integer >= 0, got ${n}`);
  }
}
function abytes(value, length, title = "") {
  const bytes2 = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes2 || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes2 ? `length=${len}` : `type=${typeof value}`;
    const message = prefix + "expected Uint8Array" + ofLen + ", got " + got;
    if (!bytes2)
      throw new TypeError(message);
    throw new RangeError(message);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new RangeError('"digestInto() output" expected to be of length >=' + min);
  }
}
function u322(arr) {
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
function createHasher(hashCons, info = {}) {
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
var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
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
  let ll = add3L(Al, Bl, Xl);
  Ah = add3H(ll, Ah, Bh, Xh);
  Al = ll | 0;
  ({ Dh, Dl } = { Dh: Dh ^ Ah, Dl: Dl ^ Al });
  ({ Dh, Dl } = { Dh: rotr32H(Dh, Dl), Dl: rotr32L(Dh, Dl) });
  ({ h: Ch, l: Cl } = add(Ch, Cl, Dh, Dl));
  ({ Bh, Bl } = { Bh: Bh ^ Ch, Bl: Bl ^ Cl });
  ({ Bh, Bl } = { Bh: rotrSH(Bh, Bl, 24), Bl: rotrSL(Bh, Bl, 24) });
  BBUF[2 * a] = Al, BBUF[2 * a + 1] = Ah;
  BBUF[2 * b] = Bl, BBUF[2 * b + 1] = Bh;
  BBUF[2 * c] = Cl, BBUF[2 * c + 1] = Ch;
  BBUF[2 * d] = Dl, BBUF[2 * d + 1] = Dh;
}
function G2b(a, b, c, d, msg, x) {
  const Xl = msg[x], Xh = msg[x + 1];
  let Al = BBUF[2 * a], Ah = BBUF[2 * a + 1];
  let Bl = BBUF[2 * b], Bh = BBUF[2 * b + 1];
  let Cl = BBUF[2 * c], Ch = BBUF[2 * c + 1];
  let Dl = BBUF[2 * d], Dh = BBUF[2 * d + 1];
  let ll = add3L(Al, Bl, Xl);
  Ah = add3H(ll, Ah, Bh, Xh);
  Al = ll | 0;
  ({ Dh, Dl } = { Dh: Dh ^ Ah, Dl: Dl ^ Al });
  ({ Dh, Dl } = { Dh: rotrSH(Dh, Dl, 16), Dl: rotrSL(Dh, Dl, 16) });
  ({ h: Ch, l: Cl } = add(Ch, Cl, Dh, Dl));
  ({ Bh, Bl } = { Bh: Bh ^ Ch, Bl: Bl ^ Cl });
  ({ Bh, Bl } = { Bh: rotrBH(Bh, Bl, 63), Bl: rotrBL(Bh, Bl, 63) });
  BBUF[2 * a] = Al, BBUF[2 * a + 1] = Ah;
  BBUF[2 * b] = Bl, BBUF[2 * b + 1] = Bh;
  BBUF[2 * c] = Cl, BBUF[2 * c + 1] = Ch;
  BBUF[2 * d] = Dl, BBUF[2 * d + 1] = Dh;
}
function checkBlake2Opts(outputLen, opts = {}, keyLen, saltLen, persLen) {
  anumber(keyLen);
  if (outputLen <= 0 || outputLen > keyLen)
    throw new Error("outputLen bigger than keyLen");
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
    this.buffer32 = u322(this.buffer);
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
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      this.length += take;
      pos += take;
    }
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    const { pos, buffer32 } = this;
    this.finished = true;
    clean(this.buffer.subarray(pos));
    swap32IfBE(buffer32);
    this.compress(buffer32, 0, true);
    swap32IfBE(buffer32);
    if (out.byteOffset & 3)
      throw new RangeError('"digestInto() output" expected 4-byte aligned byteOffset, got ' + out.byteOffset);
    const state = this.get();
    const out32 = u322(out);
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
      const slt = u322(salt);
      this.v4l ^= swap8IfBE(slt[0]);
      this.v4h ^= swap8IfBE(slt[1]);
      this.v5l ^= swap8IfBE(slt[2]);
      this.v5h ^= swap8IfBE(slt[3]);
    }
    if (personalization !== void 0) {
      abytes(personalization, void 0, "personalization");
      const pers = u322(personalization);
      this.v6l ^= swap8IfBE(pers[0]);
      this.v6h ^= swap8IfBE(pers[1]);
      this.v7l ^= swap8IfBE(pers[2]);
      this.v7h ^= swap8IfBE(pers[3]);
    }
    if (key !== void 0) {
      const tmp = new Uint8Array(this.blockLen);
      tmp.set(key);
      this.update(tmp);
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
    this.get().forEach((v, i) => BBUF[i] = v);
    BBUF.set(B2B_IV, 16);
    let { h, l } = fromBig(BigInt(this.length));
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
var import_truapi5 = require("@parity/truapi");

// dist/web/loopback-statements.js
var import_truapi4 = require("@parity/truapi");
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
function topicsOf(encoded) {
  try {
    return import_truapi4.SignedStatement.dec(bytes(encoded)).topics.map((topic) => typeof topic === "string" ? topic.toLowerCase() : hex(topic));
  } catch {
    return void 0;
  }
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
function matches2(subscription, topics) {
  if (subscription.topics.length === 0 || topics === void 0)
    return true;
  return subscription.kind === "MatchAll" ? subscription.topics.every((topic) => topics.includes(topic)) : subscription.topics.some((topic) => topics.includes(topic));
}
function createLoopbackStatements() {
  const subscriptions = /* @__PURE__ */ new Set();
  const submissions = [];
  let nextId = 1;
  const deliver = (encoded) => {
    const topics = topicsOf(encoded);
    let delivered = 0;
    for (const subscription of subscriptions) {
      if (!matches2(subscription, topics))
        continue;
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
          submissions.push(encoded);
          reply({ status: "new" });
          deliver(encoded);
          return true;
        }
        case SUBSCRIBE: {
          const id = `loopback-sub-${nextId++}`;
          subscriptions.add({
            id,
            ...parseFilter((frame.params ?? [])[0]),
            notify: respond
          });
          reply(id);
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
    submitted: () => [...submissions],
    inject: (statement) => {
      const encoded = statement.startsWith("0x") ? statement : `0x${statement}`;
      return deliver(encoded);
    },
    clear: () => {
      submissions.length = 0;
    }
  };
}

// dist/web/create-mock-host.js
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
function connectToChain(proxy, sentRpc, statementSubscriptions, loopback, injectors, disconnectors) {
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
  const { devicePermissions: devicePermissionsInitial = "allow-all", remotePermissions: remotePermissionsInitial = "allow-all", featureSupported = true, theme = "Dark", confirmUserActions = true, chainResponses = [], chainClosed = false, chainProxies = [], languageTag = "en", faults = {}, supportedChains = {
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
    permissionLog.push({ tag, value, approved, kind });
    return approved;
  };
  const productKey = (key) => `product:${key}`;
  const coreKey = (key) => key.value === void 0 ? `core:${key.tag}` : (
    // Entries sorted, so a payload built field-by-field in a different
    // order still addresses the slot it addressed before.
    `core:${key.tag}:${JSON.stringify(key.value, (_, inner) => inner !== null && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left.localeCompare(right))) : inner)}`
  );
  const granted = (policy) => policy === "allow-all";
  const decision = (approved) => approved ? "AllowAlways" : "Deny";
  const storageSubscribers = /* @__PURE__ */ new Map();
  const publishStorage = (key, value) => {
    const item = { value: value && import_truapi5.scale.bytesToHex(value) };
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
        return liveSubscription({ value: current && import_truapi5.scale.bytesToHex(current) }, subscriptionClosers, (push) => {
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
          const connection = connectToChain(proxy, sentRpc, statementSubscriptions, proxy.loopbackStatements ? loopbackStatements : void 0, chainInjectors, chainDisconnectors);
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
      async *subscribeLocale() {
        yield (0, import_neverthrow.ok)({ languageTag });
        await new Promise(() => {
        });
      }
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
      if (usingLoopback) {
        const encoded2 = typeof statement === "string" ? statement.startsWith("0x") ? statement : `0x${statement}` : `0x${hex2(statement)}`;
        injectedStatements.push(encoded2);
        return loopbackStatements.inject(encoded2);
      }
      const encoded = typeof statement === "string" ? statement.startsWith("0x") ? statement : `0x${statement}` : `0x${hex2(statement)}`;
      injectedStatements.push(encoded);
      let delivered = 0;
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
        delivered += 1;
      }
      return delivered;
    },
    getInjectedStatements: () => [...injectedStatements],
    getSubmittedStatements: () => usingLoopback ? loopbackStatements.submitted() : sentRpc.flatMap((request) => {
      try {
        const frame = JSON.parse(request);
        if (frame.method !== "statement_submit")
          return [];
        const [statement] = frame.params ?? [];
        return typeof statement === "string" ? [statement] : [];
      } catch {
        return [];
      }
    }),
    clearStatements: () => {
      injectedStatements.length = 0;
      loopbackStatements.clear();
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
      devicePermissions = behavior;
      remotePermissions = behavior;
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
    },
    revokePermission: (permission) => {
      permissionDecisions.set(permission, false);
    },
    resetPermission: (permission) => {
      permissionDecisions.delete(permission);
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

// dist/testing/host-page.js
var PRODUCT_FRAME_ID = "product-frame";
function publishTestHostGlobals(control) {
  window.__TRUAPI_TEST_HOST__ = control;
  window.__TEST_HOST__ = control;
  return () => {
    delete window.__TRUAPI_TEST_HOST__;
    delete window.__TEST_HOST__;
  };
}
async function startTestHost(options) {
  const host = createMockHost(options.mock);
  const { productId, ...hostConfig } = mockRuntimeConfig(options.runtimeConfig ?? {});
  let worker;
  let workerRuntime;
  let directRuntime;
  let runtime;
  if ((options.topology ?? "worker") === "worker") {
    worker = new Worker(options.workerUrl ?? "/test-host-worker.js", {
      type: "module"
    });
    workerRuntime = await createWebWorkerSigningHostRuntime(worker, host.callbacks, { hostConfig, role: "signing" });
    if (options.logLevel)
      workerRuntime.setLogLevel?.(options.logLevel);
    if ((options.allowances ?? "granted") === "granted") {
      await workerRuntime.setGrantAllowancesUnchecked?.(true);
    }
    runtime = workerRuntime;
  } else {
    const wasmUrl = options.wasmUrl ?? "./wasm/testing/truapi_server.js";
    const glue = await import(
      /* @vite-ignore */
      wasmUrl
    );
    await glue.default();
    if (options.logLevel)
      glue.setLogLevel?.(options.logLevel);
    const { createWasmRawCallbacks: createWasmRawCallbacks2 } = await Promise.resolve().then(() => (init_host_callbacks_adapter(), host_callbacks_adapter_exports));
    directRuntime = new glue.WasmSigningHostRuntime({
      // A raw bridge callback rather than a generated host callback, so it
      // is supplied here the way the worker runtime does. The test host runs
      // one product and starts no workers.
      ...createWasmRawCallbacks2(host.callbacks),
      workerDemandChanged: () => {
      }
    }, hostConfig);
    if ((options.allowances ?? "granted") === "granted") {
      directRuntime.setGrantAllowancesUnchecked?.(true);
    }
    const direct = directRuntime;
    runtime = {
      activateLocalSession(secret, liteUsername) {
        if (liteUsername !== void 0 && typeof direct.activateLocalSessionWithIdentity === "function") {
          return direct.activateLocalSessionWithIdentity(secret, liteUsername);
        }
        return direct.activateLocalSession(secret);
      },
      disconnectSession: () => direct.disconnectSession()
    };
  }
  let roster = (options.accounts ?? ["alice"]).map(resolveAccount);
  let active;
  const activate = async (account) => {
    if (active)
      await runtime.disconnectSession();
    await runtime.activateLocalSession(account.entropy, account.name);
    active = account;
  };
  if ((options.loginBehavior ?? "auto") === "auto") {
    const first = roster[0];
    if (!first)
      throw new Error("test host needs at least one account");
    await activate(first);
  }
  let detach;
  let publishChatAction;
  const iframeHost = createIframeHost({
    iframeUrl: options.productUrl,
    container: options.container,
    onPort(port) {
      void (async () => {
        if (workerRuntime) {
          const provider = await workerRuntime.createProvider({ productId });
          const unsubscribe = provider.subscribe((frame) => {
            port.postMessage(frame);
          });
          port.onmessage = (event) => {
            const frame = event.data;
            if (frame instanceof Uint8Array)
              provider.postMessage(frame);
          };
          publishChatAction = provider.publishChatAction ? (action) => provider.publishChatAction(action) : void 0;
          detach = () => {
            unsubscribe();
            publishChatAction = void 0;
            provider.dispose();
          };
        } else {
          const core = directRuntime.productRuntime({ productId }, {
            emitFrame(frame) {
              port.postMessage(frame);
            }
          });
          port.onmessage = (event) => {
            const frame = event.data;
            if (frame instanceof Uint8Array)
              void core.receiveFrame(frame);
          };
          publishChatAction = core.publishChatAction ? async (action) => {
            const { HostChatActionSubscribeItem } = await import("@parity/truapi");
            core.publishChatAction(HostChatActionSubscribeItem.enc(action));
          } : void 0;
          detach = () => {
            publishChatAction = void 0;
            core.dispose();
          };
        }
        port.start();
      })();
    }
  });
  const control = Object.assign(host, {
    getAccounts: () => roster.map((account) => account.name),
    getActiveAccount: () => active?.name,
    injectChatAction: async (action) => {
      if (!publishChatAction) {
        throw new Error("no product is connected, so there is no Chat action stream to publish into; wait for the product frame before injecting");
      }
      await publishChatAction(action);
    },
    async switchAccount(name) {
      const account = roster.find((entry) => entry.name === name);
      if (!account) {
        throw new Error(`no account "${name}" on this host; have ${roster.map((entry) => entry.name).join(", ")}`);
      }
      await activate(account);
    },
    async setAccounts(names) {
      roster = names.map(resolveAccount);
      const first = roster[0];
      if (!first)
        throw new Error("test host needs at least one account");
      await activate(first);
    },
    async signOut() {
      if (!active)
        return;
      await runtime.disconnectSession();
      active = void 0;
    }
  });
  iframeHost.iframe.id = PRODUCT_FRAME_ID;
  const unpublish = publishTestHostGlobals(control);
  return {
    host: control,
    iframe: iframeHost.iframe,
    dispose() {
      unpublish();
      detach?.();
      iframeHost.dispose();
      worker?.terminate();
      host.dispose();
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PRODUCT_FRAME_ID,
  publishTestHostGlobals,
  startTestHost
});
