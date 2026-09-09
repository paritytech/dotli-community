/* tslint:disable */
/* eslint-disable */

/**
 * Cancellable observation of one custom-message render instance. Dropping the
 * handle on the JS side does not stop the stream; call `cancel`.
 */
export class WasmCustomRendererSubscription {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stop delivering renderer updates. Idempotent.
     */
    cancel(): void;
}

/**
 * JS-callable handle to a long-lived pairing-host runtime shared by product
 * cores.
 */
export class WasmPairingHostRuntime {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Activate an externally persisted canonical session without writing it
     * to core storage; resolves only after product frames may use it.
     */
    activateExternalSession(blob: Uint8Array): Promise<void>;
    /**
     * Restore the persisted auth session and resolve only after it is active.
     */
    activateStoredSession(): Promise<void>;
    /**
     * Cancel an in-flight pairing flow.
     */
    cancelPairing(): void;
    /**
     * Clear one product's durable and in-memory capability state.
     */
    clearProductState(product_id: string): Promise<void>;
    /**
     * Read this device's X25519 encryption secret, generating and persisting
     * it on first read.
     */
    deviceEncryptionKey(): Promise<Uint8Array>;
    /**
     * Disconnect the shared account-authority session.
     */
    disconnectSession(): Promise<void>;
    /**
     * Build a shared runtime from host-level platform callbacks and host config.
     */
    constructor(callbacks: any, host_config: any);
    /**
     * Notify the runtime that the auth session slot may have changed.
     */
    notifySessionStoreChanged(): void;
    /**
     * Read a permission authorization status for a product.
     *
     * A device capability resolves the host application's OS gate as well as
     * storage, so an OS refusal reads as `Denied` whatever is stored. Remote,
     * identity-disclosure and account-access decisions have no OS gate.
     */
    permissionAuthorizationStatus(product_id: string, payload: Uint8Array): Promise<any>;
    /**
     * Read permission authorization statuses for a product.
     *
     * A device capability resolves the host application's OS gate as well as
     * storage, so an OS refusal reads as `Denied` whatever is stored. Remote,
     * identity-disclosure and account-access decisions have no OS gate.
     */
    permissionAuthorizationStatuses(product_id: string, payloads: Array<any>): Promise<Array<any>>;
    /**
     * Build one product-scoped runtime from this pairing host runtime.
     */
    productRuntime(product: any, core_callbacks: any): WasmProductRuntime;
    /**
     * Resolve a product's hard-subtree public key from the cache, the
     * persisted slot, or the Account Holder. `timeoutMs` bounds that wait and
     * exceeding it rejects. `undefined` when no session is active.
     */
    productSubtreePublicKey(product_id: string, timeout_ms?: number | null): Promise<Uint8Array | undefined>;
    /**
     * Clear canonical paired-session state without notifying the peer.
     */
    resetSessionState(): Promise<void>;
    /**
     * Read the active session's X25519 chat identity private key, or
     * `undefined` when no session is active.
     */
    sessionChatIdentityKey(): Uint8Array | undefined;
    /**
     * Update a stored permission authorization status for a product.
     */
    setPermissionAuthorizationStatus(product_id: string, payload: Uint8Array, status: string): Promise<void>;
}

/**
 * JS-callable handle to one product-scoped TrUAPI core.
 */
export class WasmProductRuntime {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Core-owned logout/disconnect. Best-effort notifies the SSO peer when
     * the session has channel material, then clears in-memory and persisted
     * session state.
     */
    disconnectSession(): Promise<void>;
    /**
     * Tear down the bridge. Invokes the JS-side `dispose` callback so the
     * host can drop its end of the wiring.
     */
    dispose(): void;
    /**
     * Build the core from a JS callbacks object. The object must define
     * every host capability the [`truapi_platform::Platform`] trait set
     * requires (camelCase property names; see the source for the full
     * list).
     */
    constructor(callbacks: any, runtime_config: any);
    /**
     * Read a permission authorization status without prompting.
     *
     * A device capability resolves the host application's OS gate as well as
     * storage, so an OS refusal reads as `Denied` whatever is stored. Remote,
     * identity-disclosure and account-access decisions have no OS gate.
     *
     * `payload` is a SCALE-encoded `PermissionAuthorizationRequest`.
     */
    permissionAuthorizationStatus(payload: Uint8Array): Promise<any>;
    /**
     * Read permission authorization statuses without prompting.
     *
     * A device capability resolves the host application's OS gate as well as
     * storage, so an OS refusal reads as `Denied` whatever is stored. Remote,
     * identity-disclosure and account-access decisions have no OS gate.
     *
     * `payloads` is an array of SCALE-encoded
     * `PermissionAuthorizationRequest` values. Results follow the same order.
     */
    permissionAuthorizationStatuses(payloads: Array<any>): Promise<Array<any>>;
    /**
     * Publish one host-authored Chat action into this connection's action
     * stream, buffered until the product subscribes. Takes a SCALE-encoded
     * `HostChatActionSubscribeItem`.
     */
    publishChatAction(action: Uint8Array): void;
    /**
     * Push a SCALE-encoded protocol frame into the dispatcher. Responses
     * (and subscription items) flow back through the `emitFrame`
     * callback.
     */
    receiveFrame(frame: Uint8Array): Promise<void>;
    /**
     * Start the host-initiated render subscription for one stored custom Chat
     * message. `onUpdate` receives each replacement tree as a SCALE-encoded
     * `CustomRendererNode`. Exactly one terminal follows: `onComplete` when the
     * stream ended with the last tree standing, or `onError` when the product
     * could not serve the render and the last tree is partial. Rejects when
     * this connection may not reach Chat.
     */
    renderCustomMessage(message_id: string, message_type: string, payload: Uint8Array, on_update: Function, on_complete: Function, on_error: Function): WasmCustomRendererSubscription;
    /**
     * Update a stored permission authorization status. Passing
     * `"NotDetermined"` clears the stored value so the next product request
     * prompts again.
     */
    setPermissionAuthorizationStatus(payload: Uint8Array, status: string): Promise<void>;
}

/**
 * Soft-derive a product account public key from a product's hard-subtree key
 * and a SCALE-encoded `DerivationIndex`.
 *
 * The index crosses encoded rather than as a number so the chain code stays
 * core-owned: a host that rebuilds it wrongly gets a valid-looking wrong
 * address rather than an error.
 */
export function deriveProductAccountPublicKey(product_subtree_public_key: Uint8Array, derivation_index: Uint8Array): Uint8Array;

/**
 * Strictly decode a SCALE-encoded core-storage key for host storage policy.
 */
export function describeCoreStorageKey(encoded: Uint8Array): any;

/**
 * Format a product account public key as the SS58 address host-spec C.6
 * mandates, so hosts do not each pick a prefix.
 */
export function productAccountAddress(public_key: Uint8Array): string;

/**
 * Set the live log level (`off`/`error`/`warn`/`info`/`debug`/`trace`).
 * Hosts may call this during boot, or again at any time to re-tune verbosity.
 * Unknown values are parsed as `off`.
 */
export function setLogLevel(level: string): void;

/**
 * This core's wire-contract fingerprint, for a host to stamp on each debug
 * envelope it forwards to the debugger.
 *
 * The frames a web host taps are encoded by *this* core, so the identity the
 * debugger checks has to come from here. A host that stamped its JS client's
 * hash instead would attest to a table it did not encode with: `dist/wasm/web/`
 * is a hand-built, gitignored artifact, so a stale core paired with a fresh
 * client would pass the identity check while emitting frames from a different
 * contract - exactly the silent mis-decode the fingerprint exists to stop.
 */
export function wireSchemaHash(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmcustomrenderersubscription_free: (a: number, b: number) => void;
    readonly __wbg_wasmpairinghostruntime_free: (a: number, b: number) => void;
    readonly __wbg_wasmproductruntime_free: (a: number, b: number) => void;
    readonly deriveProductAccountPublicKey: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly describeCoreStorageKey: (a: number, b: number, c: number) => void;
    readonly productAccountAddress: (a: number, b: number, c: number) => void;
    readonly setLogLevel: (a: number, b: number) => void;
    readonly wasmcustomrenderersubscription_cancel: (a: number) => void;
    readonly wasmpairinghostruntime_activateExternalSession: (a: number, b: number, c: number) => number;
    readonly wasmpairinghostruntime_activateStoredSession: (a: number) => number;
    readonly wasmpairinghostruntime_cancelPairing: (a: number) => void;
    readonly wasmpairinghostruntime_clearProductState: (a: number, b: number, c: number) => number;
    readonly wasmpairinghostruntime_deviceEncryptionKey: (a: number) => number;
    readonly wasmpairinghostruntime_disconnectSession: (a: number) => number;
    readonly wasmpairinghostruntime_new: (a: number, b: number, c: number) => void;
    readonly wasmpairinghostruntime_notifySessionStoreChanged: (a: number) => void;
    readonly wasmpairinghostruntime_permissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmpairinghostruntime_permissionAuthorizationStatuses: (a: number, b: number, c: number, d: number) => number;
    readonly wasmpairinghostruntime_productRuntime: (a: number, b: number, c: number, d: number) => void;
    readonly wasmpairinghostruntime_productSubtreePublicKey: (a: number, b: number, c: number, d: number) => number;
    readonly wasmpairinghostruntime_resetSessionState: (a: number) => number;
    readonly wasmpairinghostruntime_sessionChatIdentityKey: (a: number, b: number) => void;
    readonly wasmpairinghostruntime_setPermissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly wasmproductruntime_disconnectSession: (a: number) => number;
    readonly wasmproductruntime_dispose: (a: number, b: number) => void;
    readonly wasmproductruntime_new: (a: number, b: number, c: number) => void;
    readonly wasmproductruntime_permissionAuthorizationStatus: (a: number, b: number, c: number) => number;
    readonly wasmproductruntime_permissionAuthorizationStatuses: (a: number, b: number) => number;
    readonly wasmproductruntime_publishChatAction: (a: number, b: number, c: number, d: number) => void;
    readonly wasmproductruntime_receiveFrame: (a: number, b: number, c: number) => number;
    readonly wasmproductruntime_renderCustomMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly wasmproductruntime_setPermissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wireSchemaHash: (a: number) => void;
    readonly __wasm_bindgen_func_elem_15404: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_15406: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_4364: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_4365: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_9441: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_4366: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
