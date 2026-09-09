import type { ProductRuntimeConfig, LogLevel, PermissionAuthorizationRequest, PermissionAuthorizationStatus, ProductExecutionKind, RequiredHostCallbacks, TrUApiProductProvider } from "../index.js";
export type WebWorkerHostConfig = Omit<ProductRuntimeConfig, "productId" | "executionKind">;
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
    setLogLevel(level: LogLevel): void;
    dispose(): void;
}
export interface CreateWebWorkerPairingHostRuntimeOptions {
    logLevel?: LogLevel;
    hostConfig: WebWorkerHostConfig;
    initTimeoutMs?: number;
}
export type WebWorkerHostCallbacks = RequiredHostCallbacks;
export declare function createWebWorkerPairingHostRuntime(worker: Worker, host: WebWorkerHostCallbacks, options: CreateWebWorkerPairingHostRuntimeOptions): Promise<WorkerPairingHostRuntime>;
