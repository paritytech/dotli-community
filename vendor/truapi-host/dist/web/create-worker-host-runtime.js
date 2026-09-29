import { HostChatActionSubscribeItem as HostChatActionSubscribeItemCodec, HostRendererActionSubscribeItem as HostRendererActionSubscribeItemCodec, HostWorkerBeginOperationResponse as HostWorkerBeginOperationResponseCodec, ProductRendererRenderRequest as ProductRendererRenderRequestCodec, RendererNode as RendererNodeCodec, } from "@parity/truapi";
import { PermissionAuthorizationRequest as PermissionAuthorizationRequestCodec, ProductContext as ProductContextCodec, } from "../generated/host-callbacks.js";
import { createWasmRawCallbacks } from "../generated/host-callbacks-adapter.js";
import { isLoopbackWsUrl } from "../worker-protocol.js";
import { bytesToHex } from "@parity/truapi/scale";
import { startRawSubscription } from "../generated/worker-callbacks.js";
import { errorMessage, toError } from "../error.js";
import { validateAllowanceProductIds, } from "../wallet-allowances.js";
function debugLoggingEnabled(state) {
    return state.logLevel === "debug" || state.logLevel === "trace";
}
let nextDisconnectRequestId = 0;
let nextPermissionAuthorizationRequestId = 0;
let nextSessionChatIdentityKeyRequestId = 0;
let nextDeviceStatementKeyRequestId = 0;
let nextDeviceEncryptionKeyRequestId = 0;
let nextProductSubtreePublicKeyRequestId = 0;
let nextSessionActivationRequestId = 0;
let nextLocalIdentityRequestId = 0;
let nextAllowanceSnapshotRequestId = 0;
let nextActionRequestId = 0;
let nextRenderId = 0;
function encodePermissionAuthorizationRequest(request) {
    return PermissionAuthorizationRequestCodec.enc(request);
}
const DEV_LOG_LEVEL_KEY = "truapi:logLevel";
function readPersistedLogLevel() {
    return globalThis.localStorage?.getItem(DEV_LOG_LEVEL_KEY) ?? null;
}
/**
 * Dial URL a dev build was compiled with, when it was given one. The default,
 * not the mechanism: it lets `make debugger` hand a local stack a working tap
 * with nothing to switch on, and an explicit `debugger` option overrides it.
 *
 * Same literal-token rule as the `DEV` read below, and the try/catch covers the
 * realms with no `import.meta.env` at all.
 */
function buildTimeDebuggerUrl() {
    let raw;
    try {
        raw = import.meta.env.VITE_TRUAPI_DEBUGGER_URL;
    }
    catch {
        return null;
    }
    if (typeof raw !== "string")
        return null;
    const url = raw.trim();
    return url === "" ? null : url;
}
/**
 * Whether this build may carry a wire tap at all. A hard gate, not a convention:
 * a bundler replaces `import.meta.env.DEV` with a literal, so a production build
 * returns false and no option can turn the tap on.
 *
 * Keep the expression below the *literal* `import.meta.env.DEV`, with no alias
 * and no optional chaining. A bundler replaces that exact token; written any
 * other way it survives into the bundle and is evaluated against an
 * `import.meta.env` a plain module does not have, reading as `undefined` - which
 * refuses in every bundled host rather than only production ones, silently
 * disabling the tap everywhere. The try/catch covers where the access throws.
 */
function debuggerBuildAllows() {
    try {
        return (import.meta.env.DEV === true);
    }
    catch {
        return false;
    }
}
/**
 * Which of the two production verdicts applies. The build half is the one that
 * matters: the env var is substituted at build time, so it is still readable in
 * a production bundle, and a build made with it but without
 * `NODE_ENV=development` is exactly the case that must not go quiet.
 */
export function productionReason(fromOption, fromBuild) {
    // Same precedence as `resolveDebuggerEnablement`: an option settles it, so the
    // build is not consulted. As an OR this told a host that had refused to
    // rebuild in dev mode, which would still resolve to `not-configured`.
    const asked = fromOption === undefined
        ? fromBuild !== null
        : typeof fromOption === "string" && fromOption !== "";
    return asked ? "production-build-configured" : "production-build";
}
function readDebuggerEnablement(fromOption) {
    const fromBuild = buildTimeDebuggerUrl();
    if (!debuggerBuildAllows()) {
        // Somebody asked for a dial this build cannot carry. Going quiet is the §9
        // failure: drop `NODE_ENV=development` from the build command and you get an
        // empty board with no error, which reads as a broken debugger rather than a
        // dial compiled out. Keyed on the build value too, since that is the half
        // that survives into a production bundle.
        return { url: null, reason: productionReason(fromOption, fromBuild) };
    }
    return resolveDebuggerEnablement(fromOption, fromBuild);
}
/**
 * Resolve the dev-build switches into one verdict. Exported so the precedence is
 * testable without a bundler.
 *
 * Precedence, where an omitted option is the only one that defers to the build:
 *
 *  - option set to a URL  -> dial it, whatever the build says
 *  - option set null/""   -> OFF, whatever the build says
 *  - option omitted       -> the build's value, if it carries one
 *
 * Folding `null` in with "omitted" is the easy mistake: it falls through to the
 * build, leaving an embedder that compiled a URL in no way to refuse the dial
 * short of rebuilding. A resolved URL is loopback `ws://` or it is refused (§6).
 */
export function resolveDebuggerEnablement(fromOption, fromBuild) {
    if (typeof fromOption === "string" && fromOption !== "")
        return refuseUnlessLoopback(fromOption, "enabled-from-option");
    // Only an omitted option falls through to the build. Anything else the
    // embedder passed is a refusal, including the `false` a JS host or a
    // `wanted && url` expression yields, which must not turn the tap on.
    if (fromOption !== undefined)
        return { url: null, reason: "not-configured" };
    if (fromBuild !== null)
        return refuseUnlessLoopback(fromBuild, "enabled-from-build");
    return { url: null, reason: "not-configured" };
}
/** Let `url` through under `reason`, or refuse it for not being loopback `ws://`. */
function refuseUnlessLoopback(url, reason) {
    if (!isLoopbackWsUrl(url))
        return { url: null, reason: "refused-not-loopback" };
    return { url, reason };
}
/**
 * Say once whether the debugger will dial, and from where. The board's socket
 * count moves whether or not a host dialled (its own UI holds one), so without
 * this a host that never dialled reads as a broken debugger. Silent in a
 * production build, where nothing could be done about it anyway.
 */
function reportDebuggerEnablement(e) {
    if (e.reason === "production-build")
        return;
    if (e.reason === "production-build-configured") {
        // Says "did not resolve true", not "this is a production build". The gate
        // cannot tell the two apart: a genuine production build and a bundler that
        // never substituted the token both leave the condition false, and asserting
        // production would send a developer on a dev build under webpack or plain
        // tsc off to rebuild in dev mode - the one case that would not help.
        console.info("[truapi] wire debugger: off (a dial was configured, but " +
            "`import.meta.env.DEV` did not resolve true, so the tap is compiled out. " +
            "Either this is a production build - rebuild the host in dev mode - or " +
            "the bundler did not substitute that token.");
        return;
    }
    const origin = globalThis.location?.origin ?? "(unknown origin)";
    if (e.reason === "enabled-from-option") {
        console.info(`[truapi] wire debugger: dialling ${e.url} from the host's option (origin ${origin})`);
        return;
    }
    if (e.reason === "enabled-from-build") {
        console.info(`[truapi] wire debugger: dialling ${e.url} from the build (origin ${origin})`);
        return;
    }
    if (e.reason === "refused-not-loopback") {
        console.warn("[truapi] wire debugger: off (the configured dial is not a `ws://` URL on a " +
            "loopback host, so it was refused. The tap forwards frames verbatim, " +
            `payloads included, and never leaves this machine.) on origin ${origin}`);
        return;
    }
    console.info("[truapi] wire debugger: off (this host passed no `debugger` option and the " +
        `build carries no VITE_TRUAPI_DEBUGGER_URL) on origin ${origin}`);
}
function persistLogLevel(level) {
    globalThis.localStorage?.setItem(DEV_LOG_LEVEL_KEY, level);
}
let devLogLevelOverride = readPersistedLogLevel();
const devGlobalTargets = new Set();
/**
 * Key one pending-operation hold. `OperationId` is unique per product, not per
 * worker, so the product a `beginOperation`/`endOperation` arrived for has to be
 * part of the key. Returns null if the encoded product will not decode, which
 * drops the hold rather than letting it pin the worker forever.
 */
/**
 * Read the host-assigned id out of a `beginOperation` response. Returns null if
 * the response will not decode, so a hold that cannot be keyed is dropped
 * rather than escaping and leaving the worker's call unanswered.
 */
function operationIdFrom(value) {
    if (!(value instanceof Uint8Array))
        return null;
    try {
        return HostWorkerBeginOperationResponseCodec.dec(value).id;
    }
    catch {
        return null;
    }
}
/**
 * Key one pending-operation hold. `OperationId` is unique per product, not per
 * worker, so the product a `beginOperation`/`endOperation` arrived for has to be
 * part of the key. Returns null if the encoded product will not decode, which
 * drops the hold rather than letting it pin the worker forever.
 */
function operationHold(encodedProduct, id) {
    if (!(encodedProduct instanceof Uint8Array))
        return null;
    try {
        return `${ProductContextCodec.dec(encodedProduct).productId}\u0000${id}`;
    }
    catch {
        return null;
    }
}
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
        // Tracked in the success arm only: a rejected begin must not leave a
        // hold that nothing will ever release.
        if (msg.name === "beginOperation") {
            const id = operationIdFrom(value);
            const hold = id === null ? null : operationHold(msg.args[0], id);
            if (hold !== null)
                state.openOperations.add(hold);
        }
        else if (msg.name === "endOperation") {
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
function sendSessionActivationRequest(state, buildMessage, changesIdentity = true) {
    if (state.disposed) {
        return Promise.reject(state.closedError ?? new Error("runtime disposed"));
    }
    if (changesIdentity)
        invalidateAllowanceIdentity(state);
    return sendWorkerRequest(state, state.pendingSessionActivations, () => ++nextSessionActivationRequestId, undefined, buildMessage);
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
        onProgress,
    });
    try {
        state.worker.postMessage(buildMessage(requestId));
    }
    catch (error) {
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
    if (state.role !== "signing" ||
        state.pendingSessionActivations.size > 0 ||
        state.pendingDisconnects.size > 0) {
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
    }, 30_000);
    state.pendingAllowanceSnapshots.set(requestId, {
        resolve(snapshot) {
            clearTimeout(timeout);
            if (generation !== state.identityGeneration ||
                snapshot?.schemaVersion !== 1 ||
                (accountId !== null && snapshot.identityAccountId !== accountId) ||
                snapshot.networkSuffix !== state.networkSuffix) {
                reject(new Error("wallet allowance snapshot does not match the current identity"));
                return;
            }
            resolve(snapshot);
        },
        reject(error) {
            clearTimeout(timeout);
            reject(error);
        },
    });
    try {
        state.worker.postMessage({
            kind: "getWalletAllowanceSnapshot",
            requestId,
            productIds,
        });
    }
    catch (error) {
        settlePending(state.pendingAllowanceSnapshots, requestId, {
            ok: false,
            error: errorMessage(error),
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
/** Drop the ceiling armed by a deferred `dispose()`, if one is pending. */
function clearDisposeGrace(state) {
    if (state.disposeGraceTimer === undefined)
        return;
    clearTimeout(state.disposeGraceTimer);
    state.disposeGraceTimer = undefined;
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
    releaseDebuggerDial(state);
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
    // No role default: a host that asks for none must put exactly what it put
    // on the wire before the field existed, and the worker reads absent as
    // "pairing".
    return createWebWorkerHostRuntime(worker, host, options);
}
export function createWebWorkerSigningHostRuntime(worker, host, options) {
    return createWebWorkerHostRuntime(worker, host, {
        ...options,
        role: options.role ?? "signing",
    });
}
function createWebWorkerHostRuntime(worker, host, options) {
    const callbacks = createWasmRawCallbacks(host);
    return new Promise((resolve, reject) => {
        const state = {
            worker,
            role: options.role ?? "pairing",
            networkSuffix: "networkSuffix" in options.hostConfig
                ? options.hostConfig.networkSuffix
                : undefined,
            identityAccountId: null,
            identityGeneration: 0,
            pendingAllowanceSnapshots: new Map(),
            rawCallbacks: callbacks,
            cores: new Map(),
            pendingCores: new Map(),
            subscriptionDisposers: new Map(),
            openOperations: new Set(),
            disposePending: false,
            disposeGraceTimer: undefined,
            operationGraceMs: options.operationGraceMs ?? 30_000,
            chainConnections: new Map(),
            pendingDisconnects: new Map(),
            pendingSessionActivations: new Map(),
            pendingLocalIdentities: new Map(),
            pendingPermissionAuthorizationStatuses: new Map(),
            pendingPermissionAuthorizationStatusBatches: new Map(),
            pendingSetPermissionAuthorizationStatuses: new Map(),
            pendingSessionChatIdentityKeys: new Map(),
            pendingProductSubtreePublicKeys: new Map(),
            pendingDeviceStatementKeys: new Map(),
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
                case "walletAllowanceSnapshotResponse":
                    settlePending(state.pendingAllowanceSnapshots, msg.requestId, msg.ok
                        ? { ok: true, value: msg.snapshot }
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
        // A worker that never loads still installed its dial, and nothing will stream
        // on its account, so the badge comes off with it. Its own exit rather than
        // part of `cleanupInit`, which the `ready` path also calls.
        const failInit = (error) => {
            cleanupInit();
            releaseDebuggerDial(state);
            worker.terminate();
            reject(error);
        };
        const onError = (e) => {
            failInit(new Error(`worker init failed: ${e.message}`));
        };
        const onInitMessageError = () => {
            failInit(new Error("worker message could not be deserialized during init"));
        };
        const onRuntimeError = (e) => {
            console.error("[truapi worker]", e.message);
            notifyFault(new Error(`worker error: ${e.message}`));
        };
        const onMessageError = () => {
            notifyFault(new Error("worker message could not be deserialized"));
        };
        // Decided here, once. With no attach-later path there is no second piece of
        // state to keep in step with this one.
        const debuggerDial = installDebuggerDial(state, readDebuggerEnablement(options.debugger), options.debuggerIndicator);
        const timeoutMs = options.initTimeoutMs ?? 30_000;
        let initPhase = "loading WASM";
        let cancelInitTimeout = () => { };
        const onInitMessage = (ev) => {
            const msg = ev.data;
            if (msg.kind === "loaded") {
                initPhase = "initializing the runtime";
                scheduleInitTimeout();
                worker.postMessage({
                    kind: "init",
                    logLevel: devLogLevelOverride ?? options.logLevel ?? "off",
                    hostConfig: options.hostConfig,
                    role: options.role,
                    capabilities: {
                        chat: host.chat !== undefined,
                        permissionStatus: host.permissionStatus !== undefined,
                        pocket: host.pocket !== undefined,
                    },
                    debuggerUrl: debuggerDial,
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
                failInit(new Error(`worker init reported error: ${msg.error}`));
            }
        };
        const cleanupInit = () => {
            cancelInitTimeout();
            worker.removeEventListener("error", onError);
            worker.removeEventListener("messageerror", onInitMessageError);
            worker.removeEventListener("message", onInitMessage);
        };
        const scheduleInitTimeout = () => {
            cancelInitTimeout();
            const timeout = setTimeout(() => {
                failInit(new Error(`worker init timed out after ${timeoutMs}ms while ${initPhase}`));
            }, timeoutMs);
            cancelInitTimeout = () => clearTimeout(timeout);
        };
        scheduleInitTimeout();
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
            invalidateAllowanceIdentity(state);
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
        getDeviceStatementKey() {
            return sendWorkerRequest(state, state.pendingDeviceStatementKeys, () => ++nextDeviceStatementKeyRequestId, undefined, (requestId) => ({ kind: "getDeviceStatementKey", requestId }));
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
        activateLocalSession(secret, liteUsername) {
            return sendSessionActivationRequest(state, (requestId) => ({
                kind: "activateLocalSession",
                requestId,
                secret,
                liteUsername,
            }));
        },
        setGrantAllowancesUnchecked(granted) {
            return sendSessionActivationRequest(state, (requestId) => ({
                kind: "setGrantAllowancesUnchecked",
                requestId,
                granted,
            }), false);
        },
        resetSessionState() {
            return sendSessionActivationRequest(state, (requestId) => ({
                kind: "resetSessionState",
                requestId,
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
        getWalletAllowanceSnapshot(productIds) {
            return getWalletAllowanceSnapshot(state, productIds);
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
            invalidateAllowanceIdentity(state);
            devGlobalTargets.delete(runtime);
            // Let a background task (e.g. a funding transaction) finish; the last
            // endOperation runs the teardown. Fault teardown is never deferred.
            if (state.openOperations.size > 0) {
                state.disposePending = true;
                state.disposeGraceTimer ??= setTimeout(() => {
                    state.disposeGraceTimer = undefined;
                    if (!state.disposePending)
                        return;
                    state.disposePending = false;
                    teardown(state, new Error("runtime disposed"), false);
                }, state.operationGraceMs);
                return;
            }
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
        async getDeviceStatementKey() {
            if (core.disposed)
                return undefined;
            return runtime.getDeviceStatementKey();
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
/** Element id of the dial indicator, so a re-render finds the existing node. */
const DEBUGGER_INDICATOR_ID = "truapi-debugger-indicator";
/**
 * What the badge names: every live dial that asked to be shown, keyed by the
 * runtime owning it. A `debuggerIndicator: false` dial renders its own signal
 * and is absent, so this is not an inventory of live taps.
 *
 * One node at a fixed id serves every runtime, so keying by owner is what stops
 * one from taking down a badge another's tap is behind, and lets two live dials
 * both be named.
 */
const liveDebuggerDials = new Map();
/** Whether a paint is already waiting on `DOMContentLoaded`. */
let indicatorRepaintQueued = false;
/**
 * Put `owner`'s debugger dial into service: say once whether it will dial, show
 * the endpoint in the page for as long as it does, and hand back the URL the
 * worker's `init` message carries.
 *
 * The three are one decision, so they are one function: a host that resolves a
 * dial and then reports, badges or forwards something else is the §9 failure.
 * Taking the resolved enablement as an argument is what makes it testable.
 */
export function installDebuggerDial(owner, enablement, indicator) {
    reportDebuggerEnablement(enablement);
    if (enablement.url !== null && indicator !== false)
        liveDebuggerDials.set(owner, enablement.url);
    else
        liveDebuggerDials.delete(owner);
    paintDebuggerIndicator();
    return enablement.url;
}
/**
 * Take `owner`'s dial out of service. Its worker is gone, so nothing streams on
 * its account any more, and a badge naming an endpoint no frame reaches is the
 * silent-tap failure read backwards.
 */
export function releaseDebuggerDial(owner) {
    if (!liveDebuggerDials.delete(owner))
        return;
    paintDebuggerIndicator();
}
/**
 * Show in the page that frames are leaving, naming and linking every endpoint.
 * A console line scrolls away, so a tap left on from an earlier session is
 * invisible for the rest of the day. Default-on because the failure prevented is
 * a host forgetting; one with its own affordance passes `debuggerIndicator:
 * false`. Never throws: a badge must not stop a host starting.
 */
function paintDebuggerIndicator() {
    try {
        const doc = globalThis.document;
        if (doc === undefined)
            return;
        if (doc.body === null) {
            // A runtime created from a `<head>` script has no body yet, and returning
            // alone would leave the tap live and the badge permanently absent. The flag
            // keeps repeated paints from stacking listeners.
            if (!indicatorRepaintQueued) {
                indicatorRepaintQueued = true;
                doc.addEventListener("DOMContentLoaded", () => {
                    indicatorRepaintQueued = false;
                    paintDebuggerIndicator();
                }, { once: true });
            }
            return;
        }
        const existing = doc.getElementById(DEBUGGER_INDICATOR_ID);
        const endpoints = [...new Set(liveDebuggerDials.values())];
        if (endpoints.length === 0) {
            existing?.remove();
            return;
        }
        const el = existing ?? doc.createElement("div");
        if (existing === null) {
            el.id = DEBUGGER_INDICATOR_ID;
            // Bottom-left: the ribbon and most host chrome live on the right, and a
            // very high z-index keeps it above a modal that would otherwise hide the
            // one signal saying frames are still leaving.
            el.style.cssText =
                "position:fixed;left:8px;bottom:8px;z-index:2147483647;" +
                    "padding:4px 8px;border-radius:6px;pointer-events:none;" +
                    "background:#7a1f3d;color:#fff;font:600 11px/1.4 ui-monospace,monospace;" +
                    "box-shadow:0 2px 8px rgba(0,0,0,.4)";
            doc.body.appendChild(el);
        }
        // Each endpoint links to the board reading it, so noticing the tap and opening
        // it are one step. The badge keeps `pointer-events:none` so it never swallows
        // a click meant for the host; only the links take them back.
        el.textContent = "TrUAPI wire → ";
        endpoints.forEach((endpoint, i) => {
            if (i > 0)
                el.appendChild(doc.createTextNode(", "));
            const link = doc.createElement("a");
            // The board is served over HTTP on the port the dial streams to.
            link.href = endpoint.replace(/^ws/, "http");
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = endpoint;
            link.style.cssText =
                "color:inherit;text-decoration:underline;pointer-events:auto";
            el.appendChild(link);
        });
        el.title = "This host is streaming product wire frames to a debugger.";
    }
    catch {
        // A badge that cannot render must never disturb the host.
    }
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
