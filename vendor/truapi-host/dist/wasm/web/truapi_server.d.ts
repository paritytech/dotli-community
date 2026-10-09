/* tslint:disable */
/* eslint-disable */

/**
 * Standalone receiver with one durable writer and no wallet or product execution.
 * The host must serialize ownership across service-worker replacement and bind
 * command product IDs to trusted execution sessions, never message-body claims.
 */
export class WasmNotificationReceiver {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Execute actions 2..7 under the immutable authority captured by the trusted
     * execution channel. Authority is SCALE ReceivingAuthority, never page input.
     * Request has no version tag; response is SCALE
     * `Result<latest response, HostNotificationReceivingError>`. Action 3 requires
     * the forwarding runtime's ordinary Notifications permission authorization.
     */
    commandForExecution(authority: Uint8Array, action: number, payload: Uint8Array): Promise<Uint8Array>;
    /**
     * Construct from raw receiverAuthority/receiverConsent/receiverChanged,
     * readReceivingState and writeReceivingState callbacks. Persistence callbacks
     * are required; absent authority advertises unsupported, never enrollment.
     */
    constructor(callbacks: any);
    /**
     * Queue durable activation only after the matching product is ready.
     */
    receivingActivate(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
    /**
     * Clear a reservation only after explicit display failure, not an unknown outcome.
     */
    receivingCancelDisplay(product_id: string, revision: bigint, event_id: string): Promise<void>;
    /**
     * Confirm actual visible display, not ingestion or transport acknowledgement.
     */
    receivingConfirmDisplay(product_id: string, revision: bigint, event_id: string): Promise<void>;
    /**
     * Authenticate observed source metadata and carrier; returns SCALE `Vec<ReceivingEvent>`.
     */
    receivingIngest(product_id: string, revision: bigint, watch_id: string, actual_genesis: string, actual_channel: string, actual_topics: string[], frame: Uint8Array): Promise<Uint8Array>;
    /**
     * Authenticate a SCALE statement including source metadata; returns SCALE `Vec<ReceivingEvent>`.
     */
    receivingIngestStatement(product_id: string, revision: bigint, watch_id: string, actual_genesis: string, statement: Uint8Array): Promise<Uint8Array>;
    /**
     * Queue synchronization after the host durably changes the selected transport.
     */
    receivingMarkTransportChanged(product_id: string): Promise<void>;
    /**
     * All local registrations, including synchronized ones, as SCALE Vec.
     */
    receivingPending(): Promise<Uint8Array>;
    /**
     * Revalidate and reserve display after foreground grace; returns SCALE `Option<ReceivingEvent>`.
     */
    receivingPrepareDisplay(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
    /**
     * Revoke locally before logout or destructive identity erasure.
     */
    receivingRevoke(product_id: string): Promise<void>;
    /**
     * Acknowledge only the revision actually synchronized by transport.
     */
    receivingSynchronized(product_id: string, revision: bigint): Promise<boolean>;
    /**
     * Read-only click validation before loading the verified product; sequence is zero.
     */
    receivingValidateActivation(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
}

/**
 * JS-callable handle to a long-lived pairing-host runtime shared by product
 * cores.
 */
export class WasmPairingHostRuntime {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Take one reference on the product's worker for a modality holder. The
     * first one reports `"Start"` to the host's `workerDemandChanged`
     * callback. Pair every call with one `releaseWorker`.
     */
    acquireWorker(product_id: string): void;
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
     * Read the active session's sr25519 statement-store secret, or
     * `undefined` when no session is active.
     */
    deviceStatementKey(): Uint8Array | undefined;
    /**
     * Disconnect the shared account-authority session.
     */
    disconnectSession(): Promise<void>;
    /**
     * Pairing hosts cannot expose the signing host's private Chat roster.
     */
    getNativeChatContacts(): Promise<any>;
    /**
     * Build a shared runtime from host-level platform callbacks and host config.
     */
    constructor(callbacks: any, host_config: any);
    /**
     * Notify the runtime that the host's contacts changed, so cached contact
     * handles are dropped and the next resolution reads the list.
     */
    notifyContactsChanged(): void;
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
     * Optional platform callbacks are execution-local; shared authority stays here.
     */
    productRuntime(product: any, core_callbacks: any, platform_callbacks?: any | null): WasmProductRuntime;
    /**
     * Resolve a product's hard-subtree public key from the cache, the
     * persisted slot, or the Account Holder. `timeoutMs` bounds that wait and
     * exceeding it rejects. `undefined` when no session is active.
     */
    productSubtreePublicKey(product_id: string, timeout_ms?: number | null): Promise<Uint8Array | undefined>;
    /**
     * Resolve a click under current authority; returns SCALE `Option<ReceivingEvent>`.
     */
    receivingActivate(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
    /**
     * Clear a reservation only after explicit platform display failure.
     */
    receivingCancelDisplay(product_id: string, revision: bigint, event_id: string): Promise<void>;
    /**
     * Confirm actual platform display, not ingestion or transport acknowledgement.
     */
    receivingConfirmDisplay(product_id: string, revision: bigint, event_id: string): Promise<void>;
    /**
     * Verify source chain/channel/topics and all candidates; returns SCALE `Vec<ReceivingEvent>`.
     */
    receivingIngest(product_id: string, revision: bigint, watch_id: string, actual_genesis: string, actual_channel: string, actual_topics: string[], frame: Uint8Array): Promise<Uint8Array>;
    /**
     * Authenticate a raw SCALE statement; returns SCALE `Vec<ReceivingEvent>`.
     */
    receivingIngestStatement(product_id: string, revision: bigint, watch_id: string, actual_genesis: string, statement: Uint8Array): Promise<Uint8Array>;
    /**
     * Queue synchronization after durable provider-token rotation.
     */
    receivingMarkTransportChanged(product_id: string): Promise<void>;
    /**
     * All durable registrations as SCALE `Vec<ReceivingRegistration>`.
     */
    receivingPending(): Promise<Uint8Array>;
    /**
     * Reserve display after grace and revalidation; returns SCALE `Option<ReceivingEvent>`.
     */
    receivingPrepareDisplay(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
    /**
     * Revoke locally without waiting for remote transport.
     */
    receivingRevoke(product_id: string): Promise<void>;
    /**
     * Acknowledge the exact durable local revision synchronized by transport.
     */
    receivingSynchronized(product_id: string, revision: bigint): Promise<boolean>;
    /**
     * Validate a click without enqueueing activation; returns SCALE `Option<ReceivingEvent>`.
     */
    receivingValidateActivation(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
    /**
     * Release one reference. The last one reports `"Stop"`, after which the
     * host may stop the worker; releasing with none held is a no-op.
     */
    releaseWorker(product_id: string): void;
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
     * every host capability the [`crate::platform::Platform`] trait set
     * requires (camelCase property names; see the source for the full
     * list).
     */
    constructor(callbacks: any, runtime_config: any);
    /**
     * Notify the runtime that the host's contacts changed, so cached contact
     * handles are dropped and the next resolution asks the host.
     */
    notifyContactsChanged(): void;
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
     * Publish one action triggered inside a product-rendered body, buffered
     * until the product subscribes. Takes a SCALE-encoded
     * `HostRendererActionSubscribeItem`.
     */
    publishRendererAction(item: Uint8Array): void;
    /**
     * Push a SCALE-encoded protocol frame into the dispatcher. Responses
     * (and subscription items) flow back through the `emitFrame`
     * callback.
     */
    receiveFrame(frame: Uint8Array): Promise<void>;
    /**
     * Start the host-initiated render subscription for one body. `request` is
     * a SCALE-encoded `ProductRendererRenderRequest`. `onUpdate` receives each
     * replacement tree as a SCALE-encoded `RendererNode`. Exactly one terminal
     * follows: `onComplete` when the stream ended with the last tree standing,
     * or `onError` when the product could not serve the render and the last
     * tree is partial. Rejects when this connection may not render.
     */
    render(request: Uint8Array, on_update: Function, on_complete: Function, on_error: Function): WasmRendererSubscription;
    /**
     * Update a stored permission authorization status. Passing
     * `"NotDetermined"` clears the stored value so the next product request
     * prompts again.
     */
    setPermissionAuthorizationStatus(payload: Uint8Array, status: string): Promise<void>;
}

/**
 * Cancellable observation of one render instance. Dropping the handle on the
 * JS side does not stop the stream; call `cancel`.
 */
export class WasmRendererSubscription {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stop delivering renderer updates. Idempotent.
     */
    cancel(): void;
}

/**
 * JS-callable handle to a wallet-local signing-host runtime.
 */
export class WasmSigningHostRuntime {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Take one reference on the product's worker for a modality holder. The
     * first one reports `"Start"` to the host's `workerDemandChanged`
     * callback. Pair every call with one `releaseWorker`.
     */
    acquireWorker(product_id: string): void;
    /**
     * Activate a wallet-local session from raw BIP-39 entropy.
     */
    activateLocalSession(secret: Uint8Array): Promise<void>;
    /**
     * Activate a wallet-local session and attach known identity metadata.
     */
    activateLocalSessionWithIdentity(secret: Uint8Array, lite_username?: string | null): Promise<void>;
    /**
     * Revoke one product's grants from the current local activation.
     */
    clearProductState(product_id: string): Promise<void>;
    /**
     * Read this browser's X25519 encryption secret, generating and persisting
     * it on first read.
     */
    deviceEncryptionKey(): Promise<Uint8Array>;
    /**
     * Disconnect the active wallet-local session.
     */
    disconnectSession(): Promise<void>;
    /**
     * Read the active signing wallet's trusted native Chat directory for host UI.
     */
    getNativeChatContacts(): Promise<any>;
    /**
     * Read finalized allowance state for this activation; never allocate or sign.
     */
    getWalletAllowanceSnapshot(activation_id: string, product_ids: string[]): Promise<any>;
    /**
     * Return the UID public key followed by its native sr25519 backend-auth proof.
     */
    localIdentityAuthProof(activation_id: string, challenge: Uint8Array): Uint8Array;
    /**
     * Capture an opaque activation fence and its UID account.
     */
    localIdentityContext(): any;
    /**
     * Build registration JSON without exporting entropy or implementing proofs in JavaScript.
     */
    localLiteRegistrationBody(activation_id: string, username_base: string, verifier: Uint8Array): Promise<string>;
    /**
     * Build a shared signing runtime from host callbacks and host config.
     */
    constructor(callbacks: any, host_config: any);
    /**
     * Tell the runtime that the host's contact list changed, so cached
     * handles are dropped and the next resolution reads the list.
     */
    notifyContactsChanged(): void;
    /**
     * Read one permission authorization status for a product.
     */
    permissionAuthorizationStatus(product_id: string, payload: Uint8Array): Promise<any>;
    /**
     * Read permission authorization statuses for a product.
     */
    permissionAuthorizationStatuses(product_id: string, payloads: Array<any>): Promise<Array<any>>;
    /**
     * Build one product-scoped runtime from this signing host.
     * Optional platform callbacks are execution-local; shared authority stays here.
     */
    productRuntime(product: any, core_callbacks: any, platform_callbacks?: any | null): WasmProductRuntime;
    /**
     * Resolve a product's hard-subtree public key from the active local
     * signing session.
     */
    productSubtreePublicKey(product_id: string, timeout_ms?: number | null): Promise<Uint8Array | undefined>;
    /**
     * Resolve a click under current authority; returns SCALE `Option<ReceivingEvent>`.
     */
    receivingActivate(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
    /**
     * Clear a reservation only after explicit platform display failure.
     */
    receivingCancelDisplay(product_id: string, revision: bigint, event_id: string): Promise<void>;
    /**
     * Confirm actual platform display, not ingestion or transport acknowledgement.
     */
    receivingConfirmDisplay(product_id: string, revision: bigint, event_id: string): Promise<void>;
    /**
     * Verify source chain/channel/topics and all candidates; returns SCALE `Vec<ReceivingEvent>`.
     */
    receivingIngest(product_id: string, revision: bigint, watch_id: string, actual_genesis: string, actual_channel: string, actual_topics: string[], frame: Uint8Array): Promise<Uint8Array>;
    /**
     * Authenticate a raw SCALE statement; returns SCALE `Vec<ReceivingEvent>`.
     */
    receivingIngestStatement(product_id: string, revision: bigint, watch_id: string, actual_genesis: string, statement: Uint8Array): Promise<Uint8Array>;
    /**
     * Queue synchronization after durable provider-token rotation.
     */
    receivingMarkTransportChanged(product_id: string): Promise<void>;
    /**
     * All durable registrations as SCALE `Vec<ReceivingRegistration>`.
     */
    receivingPending(): Promise<Uint8Array>;
    /**
     * Reserve display after grace and revalidation; returns SCALE `Option<ReceivingEvent>`.
     */
    receivingPrepareDisplay(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
    /**
     * Revoke locally without waiting for remote transport.
     */
    receivingRevoke(product_id: string): Promise<void>;
    /**
     * Acknowledge the exact durable local revision synchronized by transport.
     */
    receivingSynchronized(product_id: string, revision: bigint): Promise<boolean>;
    /**
     * Validate a click without enqueueing activation; returns SCALE `Option<ReceivingEvent>`.
     */
    receivingValidateActivation(product_id: string, revision: bigint, event_id: string): Promise<Uint8Array>;
    /**
     * Install freshly verified dotNS metadata only for the captured local activation.
     */
    refreshLocalIdentity(activation_id: string): Promise<any>;
    /**
     * Release one reference. The last one reports `"Stop"`, after which the
     * host may stop the worker; releasing with none held is a no-op.
     */
    releaseWorker(product_id: string): void;
    /**
     * Read the active local session's X25519 chat identity private key.
     */
    sessionChatIdentityKey(): Uint8Array | undefined;
    /**
     * Update one stored permission authorization status for a product.
     */
    setPermissionAuthorizationStatus(product_id: string, payload: Uint8Array, status: string): Promise<void>;
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
 * Derive a product's hard-subtree public key from a session's root entropy.
 *
 * Pure: no runtime and no session, so a test harness can work out the address
 * a product will be given before it starts a host. The entropy is the same 32
 * bytes `activateLocalSession` takes.
 */
export function deriveProductSubtreePublicKey(root_entropy: Uint8Array, product_id: string): Uint8Array;

/**
 * Strictly decode a SCALE-encoded core-storage key for host storage policy.
 */
export function describeCoreStorageKey(encoded: Uint8Array): any;

/**
 * Whether `productId` is a first-party product the host grants every
 * `RemotePermission` without prompting.
 *
 * Blessed products bypass recorded permissions. Only device permissions require
 * consent. Hosts mediating product network access can use this check before storage.
 *
 * Normalizes before matching, and answers `false` for an id that does not
 * normalize, so an unknown spelling is never read as trusted.
 */
export function hasTrustedRemotePermissions(product_id: string): boolean;

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
    readonly __wbg_wasmnotificationreceiver_free: (a: number, b: number) => void;
    readonly __wbg_wasmpairinghostruntime_free: (a: number, b: number) => void;
    readonly __wbg_wasmproductruntime_free: (a: number, b: number) => void;
    readonly __wbg_wasmrenderersubscription_free: (a: number, b: number) => void;
    readonly __wbg_wasmsigninghostruntime_free: (a: number, b: number) => void;
    readonly deriveProductAccountPublicKey: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly deriveProductSubtreePublicKey: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly describeCoreStorageKey: (a: number, b: number, c: number) => void;
    readonly hasTrustedRemotePermissions: (a: number, b: number) => number;
    readonly productAccountAddress: (a: number, b: number, c: number) => void;
    readonly setLogLevel: (a: number, b: number) => void;
    readonly wasmnotificationreceiver_commandForExecution: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly wasmnotificationreceiver_new: (a: number, b: number) => void;
    readonly wasmnotificationreceiver_receivingActivate: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmnotificationreceiver_receivingCancelDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmnotificationreceiver_receivingConfirmDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmnotificationreceiver_receivingIngest: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => number;
    readonly wasmnotificationreceiver_receivingIngestStatement: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly wasmnotificationreceiver_receivingMarkTransportChanged: (a: number, b: number, c: number) => number;
    readonly wasmnotificationreceiver_receivingPending: (a: number) => number;
    readonly wasmnotificationreceiver_receivingPrepareDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmnotificationreceiver_receivingRevoke: (a: number, b: number, c: number) => number;
    readonly wasmnotificationreceiver_receivingSynchronized: (a: number, b: number, c: number, d: bigint) => number;
    readonly wasmnotificationreceiver_receivingValidateActivation: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmpairinghostruntime_acquireWorker: (a: number, b: number, c: number) => void;
    readonly wasmpairinghostruntime_activateExternalSession: (a: number, b: number, c: number) => number;
    readonly wasmpairinghostruntime_activateStoredSession: (a: number) => number;
    readonly wasmpairinghostruntime_cancelPairing: (a: number) => void;
    readonly wasmpairinghostruntime_clearProductState: (a: number, b: number, c: number) => number;
    readonly wasmpairinghostruntime_deviceEncryptionKey: (a: number) => number;
    readonly wasmpairinghostruntime_deviceStatementKey: (a: number, b: number) => void;
    readonly wasmpairinghostruntime_disconnectSession: (a: number) => number;
    readonly wasmpairinghostruntime_getNativeChatContacts: (a: number) => number;
    readonly wasmpairinghostruntime_new: (a: number, b: number, c: number) => void;
    readonly wasmpairinghostruntime_notifyContactsChanged: (a: number) => void;
    readonly wasmpairinghostruntime_notifySessionStoreChanged: (a: number) => void;
    readonly wasmpairinghostruntime_permissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmpairinghostruntime_permissionAuthorizationStatuses: (a: number, b: number, c: number, d: number) => number;
    readonly wasmpairinghostruntime_productRuntime: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmpairinghostruntime_productSubtreePublicKey: (a: number, b: number, c: number, d: number) => number;
    readonly wasmpairinghostruntime_receivingActivate: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmpairinghostruntime_receivingCancelDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmpairinghostruntime_receivingConfirmDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmpairinghostruntime_receivingIngest: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => number;
    readonly wasmpairinghostruntime_receivingIngestStatement: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly wasmpairinghostruntime_receivingMarkTransportChanged: (a: number, b: number, c: number) => number;
    readonly wasmpairinghostruntime_receivingPending: (a: number) => number;
    readonly wasmpairinghostruntime_receivingPrepareDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmpairinghostruntime_receivingRevoke: (a: number, b: number, c: number) => number;
    readonly wasmpairinghostruntime_receivingSynchronized: (a: number, b: number, c: number, d: bigint) => number;
    readonly wasmpairinghostruntime_receivingValidateActivation: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmpairinghostruntime_releaseWorker: (a: number, b: number, c: number) => void;
    readonly wasmpairinghostruntime_resetSessionState: (a: number) => number;
    readonly wasmpairinghostruntime_sessionChatIdentityKey: (a: number, b: number) => void;
    readonly wasmpairinghostruntime_setPermissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly wasmproductruntime_disconnectSession: (a: number) => number;
    readonly wasmproductruntime_dispose: (a: number, b: number) => void;
    readonly wasmproductruntime_new: (a: number, b: number, c: number) => void;
    readonly wasmproductruntime_notifyContactsChanged: (a: number) => void;
    readonly wasmproductruntime_permissionAuthorizationStatus: (a: number, b: number, c: number) => number;
    readonly wasmproductruntime_permissionAuthorizationStatuses: (a: number, b: number) => number;
    readonly wasmproductruntime_publishChatAction: (a: number, b: number, c: number, d: number) => void;
    readonly wasmproductruntime_publishRendererAction: (a: number, b: number, c: number, d: number) => void;
    readonly wasmproductruntime_receiveFrame: (a: number, b: number, c: number) => number;
    readonly wasmproductruntime_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly wasmproductruntime_setPermissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmrenderersubscription_cancel: (a: number) => void;
    readonly wasmsigninghostruntime_acquireWorker: (a: number, b: number, c: number) => void;
    readonly wasmsigninghostruntime_activateLocalSession: (a: number, b: number, c: number) => number;
    readonly wasmsigninghostruntime_activateLocalSessionWithIdentity: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmsigninghostruntime_clearProductState: (a: number, b: number, c: number) => number;
    readonly wasmsigninghostruntime_deviceEncryptionKey: (a: number) => number;
    readonly wasmsigninghostruntime_disconnectSession: (a: number) => number;
    readonly wasmsigninghostruntime_getNativeChatContacts: (a: number) => number;
    readonly wasmsigninghostruntime_getWalletAllowanceSnapshot: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmsigninghostruntime_localIdentityAuthProof: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasmsigninghostruntime_localIdentityContext: (a: number, b: number) => void;
    readonly wasmsigninghostruntime_localLiteRegistrationBody: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly wasmsigninghostruntime_new: (a: number, b: number, c: number) => void;
    readonly wasmsigninghostruntime_notifyContactsChanged: (a: number) => void;
    readonly wasmsigninghostruntime_permissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly wasmsigninghostruntime_permissionAuthorizationStatuses: (a: number, b: number, c: number, d: number) => number;
    readonly wasmsigninghostruntime_productRuntime: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmsigninghostruntime_productSubtreePublicKey: (a: number, b: number, c: number, d: number) => number;
    readonly wasmsigninghostruntime_receivingActivate: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmsigninghostruntime_receivingCancelDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmsigninghostruntime_receivingConfirmDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmsigninghostruntime_receivingIngest: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => number;
    readonly wasmsigninghostruntime_receivingIngestStatement: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly wasmsigninghostruntime_receivingMarkTransportChanged: (a: number, b: number, c: number) => number;
    readonly wasmsigninghostruntime_receivingPending: (a: number) => number;
    readonly wasmsigninghostruntime_receivingPrepareDisplay: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmsigninghostruntime_receivingRevoke: (a: number, b: number, c: number) => number;
    readonly wasmsigninghostruntime_receivingSynchronized: (a: number, b: number, c: number, d: bigint) => number;
    readonly wasmsigninghostruntime_receivingValidateActivation: (a: number, b: number, c: number, d: bigint, e: number, f: number) => number;
    readonly wasmsigninghostruntime_refreshLocalIdentity: (a: number, b: number, c: number) => number;
    readonly wasmsigninghostruntime_releaseWorker: (a: number, b: number, c: number) => void;
    readonly wasmsigninghostruntime_sessionChatIdentityKey: (a: number, b: number) => void;
    readonly wasmsigninghostruntime_setPermissionAuthorizationStatus: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly wireSchemaHash: (a: number) => void;
    readonly __wasm_bindgen_func_elem_10685: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_10742: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_4835: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_4826: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_4830: (a: number, b: number) => number;
    readonly __wasm_bindgen_func_elem_4832: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_10566: (a: number, b: number) => void;
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
