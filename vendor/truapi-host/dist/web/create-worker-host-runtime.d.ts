import type { ProductRuntimeConfig, LogLevel, PermissionAuthorizationRequest, PermissionAuthorizationStatus, ProductExecutionKind, RequiredHostCallbacks, TrUApiProductProvider, WorkerDemandChange } from "../index.js";
import type { LocalIdentity, LocalIdentityProgress } from "../worker-protocol.js";
export type WebWorkerHostConfig = Omit<ProductRuntimeConfig, "productId" | "executionKind">;
export type WebWorkerSigningHostConfig = WebWorkerHostConfig & {
    /** Bare dotNS network suffix (`dot`, `paseo`, or `testnet`). */
    networkSuffix: string;
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
    }): Promise<TrUApiProductProvider>;
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
     * Drop the active paired session without notifying the peer. Rejects on a
     * disposed runtime, as
     * {@link WorkerPairingHostRuntime.activateStoredSession} does.
     */
    resetSessionState(): Promise<void>;
    getPermissionAuthorizationStatus(productId: string, request: PermissionAuthorizationRequest): Promise<PermissionAuthorizationStatus>;
    getPermissionAuthorizationStatuses(productId: string, requests: PermissionAuthorizationRequest[]): Promise<PermissionAuthorizationStatus[]>;
    setPermissionAuthorizationStatus(productId: string, request: PermissionAuthorizationRequest, status: PermissionAuthorizationStatus): Promise<void>;
    getSessionChatIdentityKey(): Promise<Uint8Array | undefined>;
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
    /** Complete native UID auth/proofs and wait for on-chain ownership confirmation. */
    registerLocalLiteUsername(baseUsername: string, identityBackendBaseUrl: string, onProgress?: (progress: LocalIdentityProgress) => void): Promise<LocalIdentity>;
}
interface CreateWebWorkerHostRuntimeOptions {
    logLevel?: LogLevel;
    hostConfig: WebWorkerHostConfig | WebWorkerSigningHostConfig;
    initTimeoutMs?: number;
    runtimeKind?: "pairing" | "signing";
}
export interface CreateWebWorkerPairingHostRuntimeOptions extends CreateWebWorkerHostRuntimeOptions {
    hostConfig: WebWorkerHostConfig;
    runtimeKind?: "pairing";
}
export interface CreateWebWorkerSigningHostRuntimeOptions extends CreateWebWorkerHostRuntimeOptions {
    hostConfig: WebWorkerSigningHostConfig;
    runtimeKind?: "signing";
}
export type WebWorkerHostCallbacks = RequiredHostCallbacks;
export declare function createWebWorkerPairingHostRuntime(worker: Worker, host: WebWorkerHostCallbacks, options: CreateWebWorkerPairingHostRuntimeOptions): Promise<WorkerPairingHostRuntime>;
export declare function createWebWorkerSigningHostRuntime(worker: Worker, host: WebWorkerHostCallbacks, options: CreateWebWorkerSigningHostRuntimeOptions): Promise<WorkerSigningHostRuntime>;
export {};
