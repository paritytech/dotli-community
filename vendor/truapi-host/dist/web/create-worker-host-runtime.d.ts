import type { ProductRuntimeConfig, LogLevel, PermissionAuthorizationRequest, PermissionAuthorizationStatus, ProductExecutionKind, RequiredHostCallbacks, TrUApiProductProvider, WorkerDemandChange } from "../index.js";
import type { HostRole, LocalIdentity, LocalIdentityProgress } from "../worker-protocol.js";
import { type WalletAllowanceSnapshot } from "../wallet-allowances.js";
export type WebWorkerHostConfig = Omit<ProductRuntimeConfig, "productId" | "executionKind">;
export type WebWorkerSigningHostConfig = WebWorkerHostConfig & {
    /** Bare dotNS network suffix (`dot`, `paseo`, or `testnet`). */
    networkSuffix: string;
    /** Trusted u32 asset instance, required for instance-scoped Coinage runtimes. */
    coinageInstanceId?: number;
};
export interface WorkerPairingHostRuntime {
    /**
     * The encoding core's wire-schema hash, when the core reports one.
     *
     * An in-host debugger tap runs on this side of the worker boundary and has no
     * other way to reach it, so without this it can only stamp frames with the
     * page bundle's own constant — a different artifact from the core that
     * actually encoded them. The debugger then refuses to decode, exactly as it
     * should. Undefined for a core built before the export existed.
     */
    readonly coreWireSchemaHash: string | undefined;
    createProvider(product: {
        productId: string;
        executionKind?: ProductExecutionKind;
    }, callbacks?: WebWorkerHostCallbacks): Promise<TrUApiProductProvider>;
    disconnectSession(): Promise<void>;
    cancelPairing(): void;
    notifySessionStoreChanged(): void;
    /**
     * Restore the session persisted in the core's `AuthSession` slot. Resolves
     * once product frames may use it, so a host can await this at boot before
     * routing. Rejects when the runtime has been disposed or the worker faulted,
     * so a host never routes on an activation that did not run.
     */
    activateStoredSession(): Promise<void>;
    /**
     * Install an already-paired session the host holds itself, without copying
     * it into core storage. Rejects on a disposed runtime, as
     * {@link WorkerPairingHostRuntime.activateStoredSession} does.
     */
    activateExternalSession(blob: Uint8Array): Promise<void>;
    /**
     * Establish a session from host-held BIP-39 entropy.
     *
     * Signing hosts only. A pairing host has no local secret and rejects this:
     * it waits for a wallet to answer over the statement-store channel instead.
     */
    activateLocalSession(secret: Uint8Array, liteUsername?: string): Promise<void>;
    setGrantAllowancesUnchecked(granted: boolean): Promise<void>;
    /**
     * Drop the active paired session without notifying the peer. Rejects on a
     * disposed runtime, as
     * {@link WorkerPairingHostRuntime.activateStoredSession} does.
     */
    resetSessionState(): Promise<void>;
    getPermissionAuthorizationStatus(productId: string, request: PermissionAuthorizationRequest): Promise<PermissionAuthorizationStatus>;
    getPermissionAuthorizationStatuses(productId: string, requests: PermissionAuthorizationRequest[]): Promise<PermissionAuthorizationStatus[]>;
    setPermissionAuthorizationStatus(productId: string, request: PermissionAuthorizationRequest, status: PermissionAuthorizationStatus): Promise<void>;
    getSessionChatIdentityKey(): Promise<Uint8Array | undefined>;
    getDeviceStatementKey(): Promise<Uint8Array | undefined>;
    getDeviceEncryptionKey(): Promise<Uint8Array>;
    getProductSubtreePublicKey(productId: string, timeoutMs?: number): Promise<Uint8Array | undefined>;
    /**
     * Take one reference on a product's worker for a modality holder that is on
     * screen or in flight. Pair every call with one
     * {@link WorkerPairingHostRuntime.releaseWorker}. The core counts; the
     * resulting level reaches
     * {@link WorkerPairingHostRuntime.subscribeWorkerDemand} listeners, and the
     * host runs and stops the worker executable itself.
     */
    acquireWorker(productId: string): void;
    /** Release one reference. Releasing with none held is a no-op. */
    releaseWorker(productId: string): void;
    /**
     * Observe which product workers the host should run. The listener first
     * receives `wanted: true` for every product wanted right now, then each
     * change as it happens, and `wanted: false` for every remaining product
     * when the runtime is disposed. Returns the unsubscribe.
     */
    subscribeWorkerDemand(listener: (change: WorkerDemandChange) => void): () => void;
    setLogLevel(level: LogLevel): void;
    dispose(): void;
}
export interface WorkerSigningHostRuntime extends Omit<WorkerPairingHostRuntime, "cancelPairing" | "notifySessionStoreChanged" | "activateStoredSession" | "activateExternalSession" | "resetSessionState"> {
    activateLocalSession(secret: Uint8Array): Promise<void>;
    activateLocalSessionWithIdentity(secret: Uint8Array, liteUsername?: string): Promise<void>;
    /** Read dotNS ownership and install verified metadata into the native session. */
    refreshLocalIdentity(): Promise<LocalIdentity>;
    /** Read-only wallet-wide inspection bound to the native local activation. */
    getWalletAllowanceSnapshot(productIds: string[]): Promise<WalletAllowanceSnapshot>;
    /** Complete native UID auth/proofs and wait for on-chain ownership confirmation. */
    registerLocalLiteUsername(baseUsername: string, identityBackendBaseUrl: string, onProgress?: (progress: LocalIdentityProgress) => void): Promise<LocalIdentity>;
}
/**
 * Why the wire debugger is (not) enabled, so a no-dial is never silent. No
 * browser store and no runtime switch: the host passes the dial in, the build's
 * value is the default, and it is resolved once.
 */
export type DebuggerEnablement = {
    readonly url: string | null;
    readonly reason: "enabled-from-option" | "enabled-from-build" | "production-build" | "production-build-configured" | "refused-not-loopback" | "not-configured";
};
/**
 * Which of the two production verdicts applies. The build half is the one that
 * matters: the env var is substituted at build time, so it is still readable in
 * a production bundle, and a build made with it but without
 * `NODE_ENV=development` is exactly the case that must not go quiet.
 */
export declare function productionReason(fromOption: string | null | undefined, fromBuild: string | null): "production-build" | "production-build-configured";
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
export declare function resolveDebuggerEnablement(fromOption: string | null | undefined, fromBuild: string | null): DebuggerEnablement;
interface CreateWebWorkerHostRuntimeOptions {
    logLevel?: LogLevel;
    hostConfig: WebWorkerHostConfig | WebWorkerSigningHostConfig;
    initTimeoutMs?: number;
    /**
     * Dev-only: a loopback `ws://` wire debugger to stream tapped frames to.
     *
     * Omit to take what the build was compiled with
     * (`VITE_TRUAPI_DEBUGGER_URL`); pass `null` or `""` to refuse it even when the
     * build carries one. Ignored outside a dev build. Resolved once, at creation,
     * and not changeable from the page.
     */
    debugger?: string | null;
    /**
     * Dev-only: whether to show the built-in indicator while a dial is live.
     *
     * Defaults to `true`. Pass `false` only when this host renders its own visible
     * signal - the point is that a tap streaming frames off this host is never
     * invisible, not that this particular badge is used.
     */
    debuggerIndicator?: boolean;
    /**
     * Host role the worker constructs. Omitted means `"pairing"`.
     *
     * `"signing"` requires a worker loading the `testing` WASM bundle, the only
     * one built with a signing host in it.
     */
    role?: HostRole;
    /**
     * How long `dispose()` waits for open `worker.beginOperation` holds before
     * tearing down anyway. Defaults to 30s.
     */
    operationGraceMs?: number;
}
export interface CreateWebWorkerPairingHostRuntimeOptions extends CreateWebWorkerHostRuntimeOptions {
    hostConfig: WebWorkerHostConfig;
}
export interface CreateWebWorkerSigningHostRuntimeOptions extends CreateWebWorkerHostRuntimeOptions {
    hostConfig: WebWorkerSigningHostConfig;
}
export type WebWorkerHostCallbacks = RequiredHostCallbacks;
export declare function createWebWorkerPairingHostRuntime(worker: Worker, host: WebWorkerHostCallbacks, options: CreateWebWorkerPairingHostRuntimeOptions): Promise<WorkerPairingHostRuntime>;
export declare function createWebWorkerSigningHostRuntime(worker: Worker, host: WebWorkerHostCallbacks, options: CreateWebWorkerSigningHostRuntimeOptions): Promise<WorkerSigningHostRuntime>;
/**
 * Put `owner`'s debugger dial into service: say once whether it will dial, show
 * the endpoint in the page for as long as it does, and hand back the URL the
 * worker's `init` message carries.
 *
 * The three are one decision, so they are one function: a host that resolves a
 * dial and then reports, badges or forwards something else is the §9 failure.
 * Taking the resolved enablement as an argument is what makes it testable.
 */
export declare function installDebuggerDial(owner: object, enablement: DebuggerEnablement, indicator: boolean | undefined): string | null;
/**
 * Take `owner`'s dial out of service. Its worker is gone, so nothing streams on
 * its account any more, and a badge naming an endpoint no frame reaches is the
 * silent-tap failure read backwards.
 */
export declare function releaseDebuggerDial(owner: object): void;
export {};
