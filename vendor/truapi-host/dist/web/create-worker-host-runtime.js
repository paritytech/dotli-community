import { HostChatActionSubscribeItem as HostChatActionSubscribeItemCodec, HostRendererActionSubscribeItem as HostRendererActionSubscribeItemCodec, ProductRendererRenderRequest as ProductRendererRenderRequestCodec, RendererNode as RendererNodeCodec, } from "@parity/truapi";
import { PermissionAuthorizationRequest as PermissionAuthorizationRequestCodec } from "../generated/host-callbacks.js";
import { createWasmRawCallbacks } from "../generated/host-callbacks-adapter.js";
import { bytesToHex } from "@parity/truapi/scale";
import { startRawSubscription } from "../generated/worker-callbacks.js";
import { errorMessage, toError } from "../error.js";
function debugLoggingEnabled(state) {
    return state.logLevel === "debug" || state.logLevel === "trace";
}
let nextDisconnectRequestId = 0;
let nextPermissionAuthorizationRequestId = 0;
let nextSessionChatIdentityKeyRequestId = 0;
let nextDeviceEncryptionKeyRequestId = 0;
let nextProductSubtreePublicKeyRequestId = 0;
let nextSessionActivationRequestId = 0;
let nextLocalIdentityRequestId = 0;
let nextActionRequestId = 0;
let nextRenderId = 0;
function encodePermissionAuthorizationRequest(request) {
    return PermissionAuthorizationRequestCodec.enc(request);
}
const DEV_LOG_LEVEL_KEY = "truapi:logLevel";
function readPersistedLogLevel() {
    return globalThis.localStorage?.getItem(DEV_LOG_LEVEL_KEY) ?? null;
}
// Dev-only, host-agnostic enablement for the wire debugger: in a DEV build, set
// `localStorage["truapi:debugger"] = "ws://<host>:9231"` in the browser and the
// host worker dials that debugger and streams frames to it. Read here (host page)
// and forwarded to the worker in `init`; no cooperation from the embedding shell.
const DEV_DEBUGGER_URL_KEY = "truapi:debugger";
function readPersistedDebuggerUrl() {
    // Hard dev-only gate, not a convention: bundlers (Vite) replace
    // `import.meta.env.DEV` with a boolean literal, so in a PRODUCTION build this
    // returns null unconditionally and the tap is inert - a stray localStorage key
    // cannot turn the debugger on in prod. The wire debugger streams raw
    // (now fully-decoded) frames and is strictly a development tool.
    //
    // The expression below must stay the *literal* `import.meta.env.DEV`, with no
    // alias and no optional chaining. A bundler replaces that exact token; reading
    // it through `const meta = import.meta` or as `import.meta.env?.DEV` does not
    // match, so the expression survives into the bundle and is evaluated at runtime
    // against an `import.meta.env` that a plain module does not have. That reads as
    // `undefined`, and the gate then refuses in *every* bundled host rather than
    // only production ones - which silently disables the standalone tap everywhere.
    // The try/catch keeps it safe where `import.meta.env` genuinely does not exist
    // (tsc output run under Node, unit tests), where the access throws.
    let dev = false;
    try {
        dev =
            import.meta.env.DEV === true;
    }
    catch {
        dev = false;
    }
    if (!dev) {
        // A switch set on a production build is someone actively trying to enable the
        // debugger against a build that cannot carry one. Distinguish it from plain
        // production so the reporter can say so: staying silent here is what makes a
        // compiled-out dial read as a broken debugger (design doc §9).
        //
        // Both the property access and the read sit inside the try. Reading the
        // `localStorage` PROPERTY is what throws (`SecurityError`) in a storage-denied
        // realm - a sandboxed iframe without `allow-same-origin`, or blocked
        // third-party storage - while `getItem` on an available store does not. This
        // function runs inside `createWebWorkerPairingHostRuntime`'s promise executor,
        // so an escaping throw rejects host creation over a debug-only lookup.
        let switchSet = false;
        try {
            const key = globalThis.localStorage?.getItem(DEV_DEBUGGER_URL_KEY);
            switchSet = key !== null && key !== undefined && key !== "";
        }
        catch {
            switchSet = false;
        }
        return {
            url: null,
            reason: switchSet ? "production-build-switch-set" : "production-build",
        };
    }
    const storage = globalThis.localStorage;
    if (storage === undefined)
        return { url: null, reason: "no-storage" };
    const url = storage.getItem(DEV_DEBUGGER_URL_KEY);
    if (url === null || url === "")
        return { url: null, reason: "no-key" };
    return { url, reason: "enabled" };
}
/**
 * Say once whether the debugger will dial - and from which origin. Silence here
 * used to be indistinguishable from a working tap: the debugger's own socket
 * count still moves (its UI holds one), so "connected but no frames" reads as a
 * debugger bug rather than a host that never dialled.
 *
 * Silent in a production build with the switch UNSET, where the message would be
 * noise. With the switch SET it says so once even in production: someone is
 * actively trying to enable a build that cannot carry the dial, and a host whose
 * only local build is production-mode (dot.li ships `build` and `preview`, no dev
 * server) otherwise gives them no signal at all. Design doc §9.
 */
function reportDebuggerEnablement(e) {
    if (e.reason === "production-build")
        return;
    if (e.reason === "production-build-switch-set") {
        // Says "did not resolve true", not "this is a production build". The gate
        // cannot tell a production build from a bundler that never substituted the
        // token: both land on `dev === false`. Asserting production would tell a
        // developer on a genuine dev build under webpack/rollup/plain tsc to rebuild
        // in dev mode, which is the one configuration the comment above warns about.
        console.info(`[truapi] wire debugger: off (the "${DEV_DEBUGGER_URL_KEY}" switch is set, but ` +
            "`import.meta.env.DEV` did not resolve true, so the dial is compiled out. " +
            "Either this is a production build - rebuild the host in dev mode - or the " +
            "bundler did not substitute that token.");
        return;
    }
    const origin = globalThis.location?.origin ?? "(unknown origin)";
    if (e.reason === "enabled") {
        console.info(`[truapi] wire debugger: dialling ${e.url} (origin ${origin})`);
        return;
    }
    const why = e.reason === "no-storage"
        ? "no localStorage in this realm"
        : `no "${DEV_DEBUGGER_URL_KEY}" key on origin ${origin} - localStorage is ` +
            "per-origin, so set it on THIS origin (the realm that creates the host " +
            "runtime), then reload. A key on another origin is invisible here";
    console.info(`[truapi] wire debugger: off (${why})`);
}
function persistLogLevel(level) {
    globalThis.localStorage?.setItem(DEV_LOG_LEVEL_KEY, level);
}
let devLogLevelOverride = readPersistedLogLevel();
const devGlobalTargets = new Set();
function handleCallbackRequest(state, msg) {
    const fn = Object.hasOwn(state.rawCallbacks, msg.name)
        ? state.rawCallbacks[msg.name]
        : undefined;
    if (!fn) {
        state.worker.postMessage({
            kind: "callbackResponse",
            requestId: msg.requestId,
            ok: false,
            error: `unknown callback: ${msg.name}`,
        });
        return;
    }
    Promise.resolve()
        .then(() => fn(...msg.args))
        .then((value) => {
        state.worker.postMessage({
            kind: "callbackResponse",
            requestId: msg.requestId,
            ok: true,
            value,
        });
    }, (err) => {
        state.worker.postMessage({
            kind: "callbackResponse",
            requestId: msg.requestId,
            ok: false,
            error: errorMessage(err),
        });
    });
}
function handleSubscriptionStart(state, msg) {
    const sendItem = (value) => {
        if (state.disposed)
            return;
        state.worker.postMessage({
            kind: "subscriptionItem",
            subId: msg.subId,
            value,
        });
    };
    const sendError = (error) => {
        if (state.disposed)
            return;
        state.worker.postMessage({
            kind: "subscriptionError",
            subId: msg.subId,
            error: error.reason,
        });
    };
    let dispose = undefined;
    try {
        dispose = startRawSubscription(state.rawCallbacks, msg.name, msg.payload, sendItem, sendError);
    }
    catch (err) {
        console.error(`[truapi worker] ${msg.name} threw on start:`, err);
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
    }
    catch (err) {
        console.warn("[truapi worker] subscription dispose threw:", err);
    }
}
async function handleChainConnectStart(state, msg) {
    const chainConnect = state.rawCallbacks.chainConnect;
    const onResponse = (json) => {
        if (state.disposed)
            return;
        state.worker.postMessage({
            kind: "chainResponse",
            connId: msg.connId,
            json,
        });
    };
    try {
        const conn = await chainConnect(msg.genesisHash, onResponse);
        if (!conn) {
            state.worker.postMessage({
                kind: "chainConnectAck",
                connId: msg.connId,
                ok: false,
                error: `chainConnect returned null for genesisHash ${msg.genesisHash}`,
            });
            return;
        }
        state.chainConnections.set(msg.connId, conn);
        state.worker.postMessage({
            kind: "chainConnectAck",
            connId: msg.connId,
            ok: true,
        });
    }
    catch (err) {
        state.worker.postMessage({
            kind: "chainConnectAck",
            connId: msg.connId,
            ok: false,
            error: errorMessage(err),
        });
    }
}
function handleChainSend(state, msg) {
    const conn = state.chainConnections.get(msg.connId);
    if (!conn)
        return;
    try {
        if (debugLoggingEnabled(state)) {
            console.debug("[truapi worker] chainSend", msg.connId, msg.request);
        }
        conn.send(msg.request);
    }
    catch (err) {
        console.warn("[truapi worker] chain send threw:", err);
    }
}
function handleChainClose(state, msg) {
    const conn = state.chainConnections.get(msg.connId);
    if (!conn)
        return;
    state.chainConnections.delete(msg.connId);
    try {
        conn.close();
    }
    catch (err) {
        console.warn("[truapi worker] chain close threw:", err);
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
    settlePending(state.pendingDisconnects, msg.requestId, msg.ok ? { ok: true, value: undefined } : { ok: false, error: msg.error });
}
function handleSessionActivationResponse(state, msg) {
    settlePending(state.pendingSessionActivations, msg.requestId, msg.ok ? { ok: true, value: undefined } : { ok: false, error: msg.error });
}
function handlePermissionAuthorizationStatusResponse(state, msg) {
    settlePending(state.pendingPermissionAuthorizationStatuses, msg.requestId, msg.ok ? { ok: true, value: msg.status } : { ok: false, error: msg.error });
}
function handlePermissionAuthorizationStatusesResponse(state, msg) {
    settlePending(state.pendingPermissionAuthorizationStatusBatches, msg.requestId, msg.ok
        ? { ok: true, value: msg.statuses }
        : { ok: false, error: msg.error });
}
function handleSetPermissionAuthorizationStatusResponse(state, msg) {
    settlePending(state.pendingSetPermissionAuthorizationStatuses, msg.requestId, msg.ok ? { ok: true, value: undefined } : { ok: false, error: msg.error });
}
function handleSessionChatIdentityKeyResponse(state, msg) {
    settlePending(state.pendingSessionChatIdentityKeys, msg.requestId, msg.ok ? { ok: true, value: msg.key } : { ok: false, error: msg.error });
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
    rejectAll(state.pendingPermissionAuthorizationStatuses, error);
    rejectAll(state.pendingPermissionAuthorizationStatusBatches, error);
    rejectAll(state.pendingSetPermissionAuthorizationStatuses, error);
    rejectAll(state.pendingSessionChatIdentityKeys, error);
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
        }
        catch (err) {
            pending.delete(requestId);
            reject(err instanceof Error ? err : new Error(String(err)));
        }
    });
}
/**
 * Send a session activation request, rejecting rather than resolving when the
 * runtime is already gone. A host awaits these to learn whether it is signed
 * in, so a silent success after a worker fault would route it as if the
 * activation had run.
 */
function sendSessionActivationRequest(state, buildMessage) {
    if (state.disposed) {
        return Promise.reject(state.closedError ?? new Error("runtime disposed"));
    }
    return sendWorkerRequest(state, state.pendingSessionActivations, () => ++nextSessionActivationRequestId, undefined, buildMessage);
}
function sendLocalIdentityRequest(state, buildMessage, onProgress) {
    if (state.disposed) {
        return Promise.reject(state.closedError ?? new Error("runtime disposed"));
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    const requestId = ++nextLocalIdentityRequestId;
    state.pendingLocalIdentities.set(requestId, { resolve, reject, onProgress });
    try {
        state.worker.postMessage(buildMessage(requestId));
    }
    catch (error) {
        state.pendingLocalIdentities.delete(requestId);
        reject(error);
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
function teardown(state, error, fault) {
    if (state.disposed)
        return;
    state.disposed = true;
    state.closedError = error;
    rejectPendingRuntimeRequests(state, error);
    for (const core of state.cores.values()) {
        closeCoreState(core, error);
    }
    state.cores.clear();
    for (const fn of state.subscriptionDisposers.values()) {
        try {
            fn();
        }
        catch {
            // ignore during teardown
        }
    }
    state.subscriptionDisposers.clear();
    for (const conn of state.chainConnections.values()) {
        try {
            conn.close();
        }
        catch {
            // ignore during teardown
        }
    }
    state.chainConnections.clear();
    // A worker nothing can call any more is not wanted.
    for (const productId of [...state.wantedWorkers]) {
        handleWorkerDemandChanged(state, productId, false);
    }
    state.workerDemandListeners.clear();
    if (fault) {
        state.worker.terminate();
    }
    else {
        try {
            state.worker.postMessage({ kind: "dispose" });
        }
        catch {
            // ignore if worker already gone
        }
        setTimeout(() => state.worker.terminate(), 0);
    }
}
export function createWebWorkerPairingHostRuntime(worker, host, options) {
    return createWebWorkerHostRuntime(worker, host, {
        ...options,
        runtimeKind: "pairing",
    });
}
export function createWebWorkerSigningHostRuntime(worker, host, options) {
    return createWebWorkerHostRuntime(worker, host, {
        ...options,
        runtimeKind: "signing",
    });
}
function createWebWorkerHostRuntime(worker, host, options) {
    const callbacks = createWasmRawCallbacks(host);
    return new Promise((resolve, reject) => {
        const state = {
            worker,
            rawCallbacks: callbacks,
            cores: new Map(),
            pendingCores: new Map(),
            subscriptionDisposers: new Map(),
            chainConnections: new Map(),
            pendingDisconnects: new Map(),
            pendingSessionActivations: new Map(),
            pendingLocalIdentities: new Map(),
            pendingPermissionAuthorizationStatuses: new Map(),
            pendingPermissionAuthorizationStatusBatches: new Map(),
            pendingSetPermissionAuthorizationStatuses: new Map(),
            pendingSessionChatIdentityKeys: new Map(),
            pendingProductSubtreePublicKeys: new Map(),
            pendingDeviceEncryptionKeys: new Map(),
            pendingActions: new Map(),
            renders: new Map(),
            wantedWorkers: new Set(),
            workerDemandListeners: new Set(),
            closedError: null,
            logLevel: devLogLevelOverride ?? options.logLevel ?? "off",
            disposed: false,
            nextCoreId: 0,
            coreWireSchemaHash: undefined,
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
                        console.debug("[truapi worker] frame <-", bytesToHex(msg.bytes));
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
                        state.pendingLocalIdentities
                            .get(msg.requestId)
                            ?.onProgress?.(msg.progress);
                    }
                    catch {
                        // UI observers cannot fail or settle an identity operation.
                    }
                    break;
                case "localIdentityResponse":
                    settlePending(state.pendingLocalIdentities, msg.requestId, msg.ok
                        ? { ok: true, value: msg.identity }
                        : { ok: false, error: msg.error });
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
                case "deviceEncryptionKeyResponse":
                    handleDeviceEncryptionKeyResponse(state, msg);
                    break;
                case "productSubtreePublicKeyResponse":
                    handleProductSubtreePublicKeyResponse(state, msg);
                    break;
                case "workerDemandChanged":
                    // Teardown has already reported every worker unwanted, so a level
                    // still in flight would put one back that nothing can serve.
                    if (!state.disposed) {
                        handleWorkerDemandChanged(state, msg.productId, msg.wanted);
                    }
                    break;
                case "publishChatActionResponse":
                case "publishRendererActionResponse":
                    settlePending(state.pendingActions, msg.requestId, msg.ok
                        ? { ok: true, value: undefined }
                        : { ok: false, error: msg.error });
                    break;
                case "renderItem": {
                    const sink = state.renders.get(msg.renderId);
                    if (!sink)
                        break;
                    // Escaping the listener would strand the render with no terminal.
                    try {
                        sink.onUpdate(RendererNodeCodec.dec(msg.node));
                    }
                    catch (err) {
                        takeRender(state, msg.renderId);
                        state.worker.postMessage({
                            kind: "renderStop",
                            renderId: msg.renderId,
                        });
                        reportRenderFailure(sink, err);
                    }
                    break;
                }
                case "renderComplete": {
                    const sink = takeRender(state, msg.renderId);
                    try {
                        sink?.onComplete();
                    }
                    catch (err) {
                        console.warn("[truapi worker] render onComplete threw:", err);
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
                    if (debugLoggingEnabled(state)) {
                        console.debug("[truapi worker] chainConnectStart", msg.connId);
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
                    runtimeKind: options.runtimeKind,
                    capabilities: {
                        chat: host.chat !== undefined,
                        permissionStatus: host.permissionStatus !== undefined,
                        pocket: host.pocket !== undefined,
                    },
                    debuggerUrl: debuggerEnablement.url,
                });
            }
            else if (msg.kind === "ready") {
                state.coreWireSchemaHash = msg.schema;
                cleanupInit();
                worker.addEventListener("message", onMessage);
                worker.addEventListener("error", onRuntimeError);
                worker.addEventListener("messageerror", onMessageError);
                runtime = buildRuntime(state);
                exposeDevGlobal(runtime);
                resolve(runtime);
            }
            else if (msg.kind === "fatalError") {
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
        const timeoutMs = options.initTimeoutMs ?? 30_000;
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
        listeners: new Set(),
        closeListeners: new Set(),
        closedError: null,
        disposed: false,
    };
    state.cores.set(coreId, core);
    pending.resolve(buildProvider(state, core, runtime));
}
function handleCoreError(state, coreId, error) {
    const pending = state.pendingCores.get(coreId);
    if (!pending)
        return;
    state.pendingCores.delete(coreId);
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
    // Renders left registered would never settle: the worker cancels them with
    // the core, so nothing further arrives to complete the sink.
    failRendersForCore(state, coreId, failure);
    try {
        state.worker.postMessage({
            kind: "disposeCore",
            coreId,
        });
    }
    catch {
        // ignore if worker is already gone
    }
}
function buildRuntime(state) {
    const runtime = {
        coreWireSchemaHash: state.coreWireSchemaHash,
        createProvider(product) {
            if (state.disposed) {
                return Promise.reject(state.closedError ?? new Error("runtime disposed"));
            }
            return new Promise((resolve, reject) => {
                const coreId = ++state.nextCoreId;
                state.pendingCores.set(coreId, {
                    productId: product.productId,
                    resolve,
                    reject,
                });
                try {
                    state.worker.postMessage({
                        kind: "createCore",
                        coreId,
                        product,
                    });
                }
                catch (err) {
                    state.pendingCores.delete(coreId);
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            });
        },
        disconnectSession() {
            return sendWorkerRequest(state, state.pendingDisconnects, () => ++nextDisconnectRequestId, undefined, (requestId) => ({ kind: "disconnectSession", requestId }));
        },
        cancelPairing() {
            if (state.disposed)
                return;
            state.worker.postMessage({
                kind: "cancelPairing",
            });
        },
        getSessionChatIdentityKey() {
            return sendWorkerRequest(state, state.pendingSessionChatIdentityKeys, () => ++nextSessionChatIdentityKeyRequestId, undefined, (requestId) => ({ kind: "getSessionChatIdentityKey", requestId }));
        },
        getDeviceEncryptionKey() {
            // A key has no safe empty value: callers encrypt with what they get back,
            // so a disposed runtime must fail rather than hand out a zero-length one.
            // The check is synchronous with the send, so the fallback is unreachable.
            if (state.disposed) {
                return Promise.reject(new Error("worker host runtime is disposed"));
            }
            return sendWorkerRequest(state, state.pendingDeviceEncryptionKeys, () => ++nextDeviceEncryptionKeyRequestId, new Uint8Array(), (requestId) => ({ kind: "getDeviceEncryptionKey", requestId }));
        },
        getProductSubtreePublicKey(productId, timeoutMs) {
            return sendWorkerRequest(state, state.pendingProductSubtreePublicKeys, () => ++nextProductSubtreePublicKeyRequestId, undefined, (requestId) => ({
                kind: "getProductSubtreePublicKey",
                requestId,
                productId,
                timeoutMs,
            }));
        },
        notifySessionStoreChanged() {
            if (state.disposed)
                return;
            state.worker.postMessage({
                kind: "notifySessionStoreChanged",
            });
        },
        acquireWorker(productId) {
            postUnlessDisposed(state, { kind: "acquireWorker", productId });
        },
        releaseWorker(productId) {
            postUnlessDisposed(state, { kind: "releaseWorker", productId });
        },
        subscribeWorkerDemand(listener) {
            // Teardown cleared the listeners, so one added now would only be
            // retained, never called.
            if (state.disposed)
                return () => { };
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
                requestId,
            }));
        },
        activateExternalSession(blob) {
            return sendSessionActivationRequest(state, (requestId) => ({
                kind: "activateExternalSession",
                requestId,
                blob,
            }));
        },
        resetSessionState() {
            return sendSessionActivationRequest(state, (requestId) => ({
                kind: "resetSessionState",
                requestId,
            }));
        },
        activateLocalSession(secret) {
            return sendSessionActivationRequest(state, (requestId) => ({
                kind: "activateLocalSession",
                requestId,
                secret,
            }));
        },
        activateLocalSessionWithIdentity(secret, liteUsername) {
            return sendSessionActivationRequest(state, (requestId) => ({
                kind: "activateLocalSessionWithIdentity",
                requestId,
                secret,
                liteUsername,
            }));
        },
        refreshLocalIdentity() {
            return sendLocalIdentityRequest(state, (requestId) => ({
                kind: "refreshLocalIdentity",
                requestId,
            }));
        },
        registerLocalLiteUsername(baseUsername, identityBackendBaseUrl, onProgress) {
            return sendLocalIdentityRequest(state, (requestId) => ({
                kind: "registerLocalLiteUsername",
                requestId,
                baseUsername,
                identityBackendBaseUrl,
            }), onProgress);
        },
        getPermissionAuthorizationStatus(productId, request) {
            return sendWorkerRequest(state, state.pendingPermissionAuthorizationStatuses, () => ++nextPermissionAuthorizationRequestId, "NotDetermined", (requestId) => ({
                kind: "getPermissionAuthorizationStatus",
                productId,
                requestId,
                request: encodePermissionAuthorizationRequest(request),
            }));
        },
        getPermissionAuthorizationStatuses(productId, requests) {
            return sendWorkerRequest(state, state.pendingPermissionAuthorizationStatusBatches, () => ++nextPermissionAuthorizationRequestId, requests.map(() => "NotDetermined"), (requestId) => ({
                kind: "getPermissionAuthorizationStatuses",
                productId,
                requestId,
                requests: requests.map(encodePermissionAuthorizationRequest),
            }));
        },
        setPermissionAuthorizationStatus(productId, request, status) {
            return sendWorkerRequest(state, state.pendingSetPermissionAuthorizationStatuses, () => ++nextPermissionAuthorizationRequestId, undefined, (requestId) => ({
                kind: "setPermissionAuthorizationStatus",
                productId,
                requestId,
                request: encodePermissionAuthorizationRequest(request),
                status,
            }));
        },
        setLogLevel(level) {
            if (state.disposed)
                return;
            state.logLevel = level;
            state.worker.postMessage({
                kind: "setLogLevel",
                level,
            });
        },
        dispose() {
            devGlobalTargets.delete(runtime);
            teardown(state, new Error("runtime disposed"), false);
        },
    };
    return runtime;
}
/** Post a fire-and-forget control message; a disposed runtime drops it. */
function postUnlessDisposed(state, message) {
    if (state.disposed)
        return;
    state.worker.postMessage(message);
}
/** Hand one change to one listener, keeping its throw off the caller. */
function deliverWorkerDemand(listener, change) {
    try {
        listener(change);
    }
    catch (err) {
        console.warn("[truapi worker] worker demand listener threw:", err);
    }
}
/** Record one product's wanted level and fan it out to every listener. */
function handleWorkerDemandChanged(state, productId, wanted) {
    if (wanted)
        state.wantedWorkers.add(productId);
    else
        state.wantedWorkers.delete(productId);
    // Delivery runs over a snapshot, and skips anyone no longer subscribed when
    // their turn comes: a listener that subscribes from inside a listener has
    // already had this change replayed to it, and one that unsubscribes, or
    // disposes the runtime, must hear nothing further.
    for (const listener of [...state.workerDemandListeners]) {
        if (!state.workerDemandListeners.has(listener))
            continue;
        deliverWorkerDemand(listener, { productId, wanted });
    }
}
/** Deliver a render failure without letting the sink's own throw escape. */
function reportRenderFailure(sink, cause) {
    try {
        sink.onError?.(toError(cause));
    }
    catch (err) {
        console.warn("[truapi worker] render onError threw:", err);
    }
}
/**
 * Drop one render from the ledger, returning its sink only the first time,
 * which is what keeps a render settled exactly once.
 */
function takeRender(state, renderId) {
    const entry = state.renders.get(renderId);
    if (!entry)
        return undefined;
    state.renders.delete(renderId);
    return entry;
}
/** Settle and drop every render belonging to one product connection. */
function failRendersForCore(state, coreId, error) {
    for (const [renderId, entry] of [...state.renders]) {
        if (entry.coreId !== coreId)
            continue;
        const sink = takeRender(state, renderId);
        if (sink)
            reportRenderFailure(sink, error);
    }
}
/**
 * Post one host-authored action to the worker and settle on its response.
 * Encoding runs before registering, so a payload the codec rejects leaves no
 * pending entry behind.
 */
function publishAction(state, core, kind, encode) {
    if (state.disposed || core.disposed) {
        return Promise.reject(new Error("product connection is closed"));
    }
    let action;
    try {
        action = encode();
    }
    catch (err) {
        return Promise.reject(toError(err));
    }
    return sendWorkerRequest(state, state.pendingActions, () => nextActionRequestId++, undefined, (requestId) => ({ kind, coreId: core.coreId, requestId, action }));
}
function buildProvider(state, core, runtime) {
    const provider = {
        postMessage(bytes) {
            if (state.disposed || core.disposed)
                return;
            if (debugLoggingEnabled(state)) {
                console.debug("[truapi worker] frame ->", bytesToHex(bytes));
            }
            state.worker.postMessage({
                kind: "frame",
                coreId: core.coreId,
                bytes,
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
                return () => { };
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
                return undefined;
            const key = await runtime.getSessionChatIdentityKey();
            return key && bytesToHex(key);
        },
        async getDeviceEncryptionKey() {
            if (core.disposed) {
                throw new Error("product connection is closed");
            }
            return bytesToHex(await runtime.getDeviceEncryptionKey());
        },
        async getProductSubtreePublicKey(productId, timeoutMs) {
            if (core.disposed)
                return undefined;
            const key = await runtime.getProductSubtreePublicKey(productId, timeoutMs);
            return key && bytesToHex(key);
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
            if (core.disposed)
                return Promise.resolve();
            return runtime.setPermissionAuthorizationStatus(core.productId, request, status);
        },
        setLogLevel(level) {
            if (core.disposed)
                return;
            runtime.setLogLevel(level);
        },
        publishChatAction(action) {
            return publishAction(state, core, "publishChatAction", () => HostChatActionSubscribeItemCodec.enc(action));
        },
        publishRendererAction(item) {
            return publishAction(state, core, "publishRendererAction", () => HostRendererActionSubscribeItemCodec.enc(item));
        },
        render(request, sink) {
            if (state.disposed || core.disposed) {
                sink.onError?.(new Error("product connection is closed"));
                return () => { };
            }
            // Encode before registering, so a request the codec rejects leaves no
            // render behind that the worker was never told about.
            let encoded;
            try {
                encoded = ProductRendererRenderRequestCodec.enc(request);
            }
            catch (err) {
                reportRenderFailure(sink, err);
                return () => { };
            }
            const renderId = nextRenderId++;
            // No worker reference is taken here: the core holds the one an open
            // render is worth and reports it through `workerDemandChanged`.
            state.renders.set(renderId, {
                coreId: core.coreId,
                onUpdate: (node) => sink.onUpdate(node),
                onComplete: () => sink.onComplete?.(),
                onError: (error) => sink.onError?.(error),
            });
            try {
                state.worker.postMessage({
                    kind: "renderStart",
                    coreId: core.coreId,
                    renderId,
                    request: encoded,
                });
            }
            catch (err) {
                const failed = takeRender(state, renderId);
                if (failed)
                    reportRenderFailure(failed, err);
                return () => { };
            }
            return () => {
                if (!takeRender(state, renderId))
                    return;
                state.worker.postMessage({
                    kind: "renderStop",
                    renderId,
                });
            };
        },
        dispose() {
            if (core.disposed)
                return;
            closeCoreState(core, new Error("provider disposed"));
            state.cores.delete(core.coreId);
            // Renders left registered would never settle: the worker cancels them
            // with the core, so nothing further arrives to complete the sink.
            failRendersForCore(state, core.coreId, new Error("provider disposed"));
            state.worker.postMessage({
                kind: "disposeCore",
                coreId: core.coreId,
            });
        },
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
        },
    };
}
publishDevGlobal();
