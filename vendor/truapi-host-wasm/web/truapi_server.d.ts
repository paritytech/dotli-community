/* tslint:disable */
/* eslint-disable */

/**
 * JS-callable handle to a long-lived pairing-host runtime shared by product
 * cores.
 */
export class WasmPairingHostRuntime {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Cancel an in-flight pairing flow.
     */
    cancelPairing(): void;
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
     * Read a stored permission authorization status for a product.
     */
    permissionAuthorizationStatus(product_id: string, payload: Uint8Array): Promise<any>;
    /**
     * Read stored permission authorization statuses for a product.
     */
    permissionAuthorizationStatuses(product_id: string, payloads: Array<any>): Promise<Array<any>>;
    /**
     * Build one product-scoped runtime from this pairing host runtime.
     */
    productRuntime(product: any, core_callbacks: any): WasmProductRuntime;
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
     * Read a stored permission authorization status without prompting.
     *
     * `payload` is a SCALE-encoded `PermissionAuthorizationRequest`.
     */
    permissionAuthorizationStatus(payload: Uint8Array): Promise<any>;
    /**
     * Read stored permission authorization statuses without prompting.
     *
     * `payloads` is an array of SCALE-encoded
     * `PermissionAuthorizationRequest` values. Results follow the same order.
     */
    permissionAuthorizationStatuses(payloads: Array<any>): Promise<Array<any>>;
    /**
     * Push a SCALE-encoded protocol frame into the dispatcher. Responses
     * (and subscription items) flow back through the `emitFrame`
     * callback.
     */
    receiveFrame(frame: Uint8Array): Promise<void>;
    /**
     * Update a stored permission authorization status. Passing
     * `"NotDetermined"` clears the stored value so the next product request
     * prompts again.
     */
    setPermissionAuthorizationStatus(payload: Uint8Array, status: string): Promise<void>;
}

/**
 * Set the live log level (`off`/`error`/`warn`/`info`/`debug`/`trace`).
 * Hosts may call this during boot, or again at any time to re-tune verbosity.
 * Unknown values are parsed as `off`.
 */
export function setLogLevel(level: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmpairinghostruntime_free: (a: number, b: number) => void;
    readonly __wbg_wasmproductruntime_free: (a: number, b: number) => void;
    readonly setLogLevel: (a: number, b: number) => void;
    readonly wasmpairinghostruntime_cancelPairing: (a: number) => void;
    readonly wasmpairinghostruntime_disconnectSession: (a: number) => number;
    readonly wasmpairinghostruntime_new: (a: number, b: number, c: number) => void;
    readonly wasmpairinghostruntime_notifySessionStoreChanged: (a: number) => void;
    readonly wasmpairinghostruntime_permissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmpairinghostruntime_permissionAuthorizationStatuses: (a: number, b: number, c: number, d: number) => number;
    readonly wasmpairinghostruntime_productRuntime: (a: number, b: number, c: number, d: number) => void;
    readonly wasmpairinghostruntime_setPermissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly wasmproductruntime_disconnectSession: (a: number) => number;
    readonly wasmproductruntime_dispose: (a: number, b: number) => void;
    readonly wasmproductruntime_new: (a: number, b: number, c: number) => void;
    readonly wasmproductruntime_permissionAuthorizationStatus: (a: number, b: number, c: number) => number;
    readonly wasmproductruntime_permissionAuthorizationStatuses: (a: number, b: number) => number;
    readonly wasmproductruntime_receiveFrame: (a: number, b: number, c: number) => number;
    readonly wasmproductruntime_setPermissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly __wasm_bindgen_func_elem_10810: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_10813: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_2062: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_6634: (a: number, b: number) => void;
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
