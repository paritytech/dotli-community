import type { ChatMessageContent, ChatRoom, HostChatRegisterBotRequest, ThemeVariant } from "@parity/truapi";
import type { AuthState, HostChainSet, RequiredHostCallbacks, UserConfirmationReview } from "../generated/host-callbacks.js";
import type { ProductRuntimeConfig } from "../runtime.js";
/** How the mock answers a permission prompt for one capability. */
export type PermissionPolicy = "allow-all" | "deny-all";
export interface ChainProxy {
    /**
     * Genesis hash to route on. Omit to take every request no hashed entry
     * claims.
     *
     * Omitting it is usually right for a single-chain suite, and is immune to a
     * reset: a public testnet's genesis changes when it is reset, which silently
     * breaks hash routing and is exactly how a pinned hash goes stale. Give a
     * hash only when routing between several chains, and expect to re-pin it.
     */
    genesisHash?: string;
    /** WebSocket endpoint, e.g. `wss://paseo-asset-hub-next-rpc.polkadot.io`. */
    rpcUrl: string;
    /**
     * Serve the statement store in-page for this chain rather than forwarding it.
     *
     * Everything else still goes to `rpcUrl`, so a chain can carry real reads and
     * a local statement store at once. A statement accepted here is registered
     * nowhere, so a real store would refuse it.
     */
    loopbackStatements?: boolean;
}
/** Optional error injection, mirroring the Rust `MockFaults`. */
export interface MockFaults {
    /** Product and core storage reads/writes/clears fail with this reason. */
    storageError?: string;
    /** `navigateTo` fails with this reason. */
    navigateError?: string;
    /** `pushNotification` fails with this reason. */
    notificationError?: string;
    /**
     * `confirmUserAction` fails with this reason instead of answering.
     *
     * Distinct from a declined confirmation: the host could not put the question
     * to the user at all, which the core must not read as a refusal.
     */
    confirmationError?: string;
    /** Device and remote permission prompts fail with this reason. */
    permissionError?: string;
    /** `featureSupported` and `supportedChains` fail with this reason. */
    featureError?: string;
    /** Chat room, bot, and message calls fail with this reason. */
    chatError?: string;
}
/** Which prompt surface a permission decision came from. */
export type PermissionKind = "device" | "remote";
/**
 * One notification the product pushed, recorded for assertions.
 *
 * Field names are `@parity/host-api-test-sdk`'s `NotificationLogEntry`, so an
 * assertion written against that shape reads this one. The entry outlives the
 * request:
 * `cancelled` flips in place when the product cancels by id, which is what a
 * suite asserts on rather than a separate cancellation list.
 */
export interface NotificationLogEntry {
    /** Host-assigned id, the same one `cancelNotification` takes. */
    id: number;
    /** Notification text. */
    text: string;
    /** Optional URL to open on tap. */
    deeplink: string | undefined;
    /** Delivery time in epoch-ms, or undefined for immediate. */
    scheduledAt: bigint | undefined;
    /** Set once the product cancels this notification. */
    cancelled: boolean;
    /** When the mock recorded it. */
    timestamp: number;
}
/** One operation a product began and has not ended. */
export interface OpenOperation {
    /** Product that began it. */
    productId: string;
    /** Id the mock handed back, unique among this product's open operations. */
    id: number;
    /** Label the product gave, empty when it gave none. */
    label: string;
}
/**
 * One permission answer the mock gave, recorded for assertions.
 *
 * Field names are `@parity/host-api-test-sdk`'s `PermissionLogEntry`, so an
 * assertion written against that shape reads this one.
 */
export interface PermissionLogEntry {
    /** The request's tag, the same key `grantPermission` takes. */
    tag: string;
    /** The full request, for a permission that carries one. */
    value: unknown;
    /** What the mock answered. */
    approved: boolean;
    /** Which prompt surface asked. */
    kind: PermissionKind;
}
/**
 * One signing request the core put to the host.
 *
 * The signing-shaped view of {@link MockHost.reviews}: a TrUAPI host confirms
 * signatures rather than performing them, so what it sees is the review, and
 * `payload` is that review's own payload rather than a host-assembled one.
 */
export interface SigningLogEntry {
    /** Which signing request was reviewed. */
    type: "payload" | "raw" | "createTransaction";
    /** The reviewed request. */
    payload: unknown;
}
/** One chat message the product posted through the mock. */
export interface ChatMessageRecord {
    /** Id the mock assigned and returned to the product. */
    messageId: string;
    /** Room the message was posted to. */
    roomId: string;
    /** What was posted. */
    payload: ChatMessageContent;
}
/** State of the mock's chain connection, as the host sees it. */
export type ChainStatus = "Idle" | "Connected" | "Disconnected";
/** Behavior knobs for {@link createMockHost}. */
export interface MockHostConfig {
    /** Answer for `devicePermission`. Default `"allow-all"`. */
    devicePermissions?: PermissionPolicy;
    /** Answer for `remotePermission`. Default `"allow-all"`. */
    remotePermissions?: PermissionPolicy;
    /** Whether `featureSupported` reports support. Default `true`. */
    featureSupported?: boolean;
    /** Theme emitted by `subscribeTheme`. Default `"Dark"`. */
    theme?: ThemeVariant;
    /** BCP 47 tag emitted by `subscribeLocale`. Default `"en"`. */
    languageTag?: string;
    /** Whether `confirmUserAction` confirms reviewed actions. Default `true`. */
    confirmUserActions?: boolean;
    /**
     * JSON-RPC response frames the chain connection replays, in order. Empty
     * (the default) means a silent connection: it records outbound requests and
     * never answers, so chain-dependent flows park.
     */
    chainResponses?: string[];
    /**
     * When `true`, the chain response stream ends immediately instead of parking,
     * so disconnect/timeout paths can be asserted (fail-fast). Ignored when
     * `chainResponses` is non-empty.
     */
    chainClosed?: boolean;
    /**
     * Error injection. When a field is set, the matching host call rejects with
     * that reason instead of succeeding.
     */
    faults?: MockFaults;
    /**
     * Chains to proxy to a real node instead of answering from memory.
     *
     * Empty by default, which keeps the host hermetic: nothing reaches the
     * network. Supplying an entry trades that away for real chain behaviour --
     * inclusion, finalization, live state -- and inherits the flakiness that
     * comes with it, including state other runs left behind and contracts that
     * were reaped. Proxy only the chains a suite genuinely needs.
     *
     * Connections open lazily, on the first request for a matching hash, so a
     * declared proxy that is never used opens no socket.
     */
    chainProxies?: ChainProxy[];
    /**
     * Chains the host reports serving (RFC 0026). Defaults to the three
     * {@link MOCK_GENESIS} chains, which are what {@link mockRuntimeConfig}
     * declares.
     *
     * An empty set type-checks and then fails every chain-routed call, so
     * override this only to assert that failure.
     */
    supportedChains?: HostChainSet;
}
/** A mock host: the callbacks to wire into a provider, plus assertion oracles. */
export interface MockHost {
    /**
     * The nested host-callback surface. Pass to `createWasmRawCallbacks` or hand
     * to `createWebWorkerPairingHostRuntime` (both accept `RequiredHostCallbacks`).
     */
    callbacks: RequiredHostCallbacks;
    /** URLs the core asked the host to open, in order. */
    getNavigationLog(): string[];
    /** Notifications the core asked the host to show, in order. */
    getNotificationLog(): NotificationLogEntry[];
    /**
     * Deliver a SCALE-encoded signed statement to the product as a chain
     * notification, returning how many live subscriptions it reached. Zero means
     * the product is not subscribed yet: subscribe first, then inject.
     *
     * The bytes are the wire form, not a structured statement. The core decodes
     * what the chain would have sent it, so anything else is dropped during
     * decode with no error a suite can see.
     */
    injectStatement(statement: Uint8Array | string): number;
    /** Statements injected so far, in order, as `0x` hex. */
    getInjectedStatements(): string[];
    /**
     * Statements the product submitted, as `0x` hex, read off the chain
     * transport.
     *
     * The core sends `statement_submit` without consulting an allowance, so a
     * product that signs its own statements is observable here. One that asks the
     * host to sign first (`createProofAuthorized`) needs a statement allowance to
     * get that far, and this stays empty until it has one.
     */
    getSubmittedStatements(): string[];
    /** Forget the injected statements. Delivered ones cannot be recalled. */
    clearStatements(): void;
    /** Raw JSON-RPC the core sent over the chain connection, in order. */
    sentRpc(): string[];
    /** Auth-state transitions the core emitted, in order. */
    authStates(): AuthState[];
    /**
     * Full confirmation reviews the core requested, in order.
     *
     * Carries the reviewed payload, not just its kind: a `SignRaw` review holds
     * the bytes the product asked to have signed, so a test can assert *what*
     * was put to the user rather than only that something was.
     */
    reviews(): UserConfirmationReview[];
    /** Confirmation kinds the core requested (review `tag`s), in order. */
    confirmations(): string[];
    /**
     * Signing requests the core put to the host, in order.
     *
     * A filtered view of {@link MockHost.reviews}: only the reviews that gate a
     * signature, shaped the way a signing log is usually read.
     */
    getSigningLog(): SigningLogEntry[];
    /**
     * How many calls the core has made into the host.
     *
     * Non-zero is the first observable evidence that frames are crossing the
     * wire, which is what a harness waits on before asserting anything.
     */
    getHostCallCount(): number;
    /** Whether the core has reported an authenticated session. */
    getIsAuthenticated(): boolean;
    /**
     * Whether the product-host link is up.
     *
     * The mock has no transport of its own, so this reports the chain-side
     * connection it does model; a harness owning the real product link should
     * report that instead.
     */
    getConnectionStatus(): ChainStatus;
    /** Switch the answer both permission prompts fall back to. */
    setPermissionBehavior(behavior: PermissionPolicy): void;
    /**
     * Release the mock's state and drop every live subscription.
     *
     * {@link MockHost.reset} leaves subscriptions open and tells them what
     * changed; this ends them, so a host kept across a suite does not carry a
     * previous case's subscribers.
     */
    dispose(): void;
    /** Permission answers the mock gave, in order. */
    getPermissionLog(): PermissionLogEntry[];
    /** Operations a product began and has not ended, in the order they began. */
    getOpenOperations(): OpenOperation[];
    /** Permissions with an explicit grant, in key order. */
    getGrantedPermissions(): string[];
    /** Answer `permission` with a grant, whatever the configured policy says. */
    grantPermission(permission: string): void;
    /** Answer `permission` with a denial, whatever the configured policy says. */
    revokePermission(permission: string): void;
    /** Drop the explicit answer for `permission`, restoring policy fallback. */
    resetPermission(permission: string): void;
    /**
     * When enforcing, deny every permission without an explicit grant instead of
     * falling back to the configured policy. Off by default.
     */
    setEnforcePermissions(enforce: boolean): void;
    /** The theme the mock currently reports. */
    getTheme(): ThemeVariant;
    /** Replace the reported theme. */
    setTheme(variant: ThemeVariant): void;
    /** State of the mock's chain connection. */
    getChainStatus(): ChainStatus;
    /** Mark the chain disconnected, as a dropped transport would. */
    simulateDisconnect(): void;
    /** Allow connections again after a simulated disconnect. */
    simulateReconnect(): void;
    /** Chat rooms the product registered. */
    getChatRooms(): ChatRoom[];
    /** Chat bots the product registered. */
    getChatBots(): HostChatRegisterBotRequest[];
    /** Messages the product posted, with the ids the mock assigned. */
    getChatMessageLog(): ChatMessageRecord[];
    /**
     * Product-scoped storage the core has written, keyed without the internal
     * namespace prefix.
     *
     * A test asserting what the product stored should read it here rather than
     * reach into whatever the host keeps underneath: the namespacing is an
     * implementation detail and tying a suite to it is what makes a host
     * impossible to replace.
     */
    getProductStorage(): Record<string, Uint8Array>;
    /** Seeded preimage values. */
    getPreimages(): Uint8Array[];
    /** Drop the recorded navigations. */
    clearNavigationLog(): void;
    /** Drop the recorded shown and cancelled notifications. */
    clearNotificationLog(): void;
    /** Drop the recorded confirmation reviews. */
    clearSigningLog(): void;
    /** Drop the recorded permission answers, keeping explicit grants. */
    clearPermissionLog(): void;
    /** Drop every explicit permission grant and denial. */
    clearPermissionDecisions(): void;
    /** Drop the recorded auth-state transitions. */
    clearAuthStates(): void;
    /** Drop the recorded outbound JSON-RPC. */
    clearSentRpc(): void;
    /** Drop the seeded preimages. */
    clearPreimages(): void;
    /** Drop the product and core storage contents. */
    clearStorage(): void;
    /** Drop the registered rooms and bots and the posted-message log. */
    clearChatState(): void;
    /**
     * Return the mock to its freshly-constructed state, keeping its config.
     *
     * Tests reset between cases; doing it in one call is what keeps a recording
     * from one case out of the assertions of the next.
     */
    reset(): void;
    /**
     * The statement store, which the core owns and submits over the people
     * chain. Every access throws: there is no host seam to record or inject
     * through, so the mock cannot model it without chain support.
     */
    statements: never;
    /**
     * Payments, which TrUAPI declares but no host implements. Every access
     * throws; see {@link notModeled}.
     */
    payment: never;
    /** Coin payments, unimplemented in the same way as {@link MockHost.payment}. */
    coinPayment: never;
    /** Notification ids the core asked the host to cancel, in order. */
    cancelledNotifications(): number[];
    /**
     * Seed a preimage so a later `preimage.lookupPreimage` resolves it, and
     * return the deterministic lookup key. The core (not the host) owns Bulletin
     * submission on current core; this is the host-side content store the mock's
     * `lookupPreimage` reads from.
     */
    seedPreimage(value: Uint8Array): Uint8Array;
}
/**
 * Build an in-memory mock host. The returned `callbacks` implement every
 * `RequiredHostCallbacks` capability; the accessor methods expose what the core
 * did.
 */
export declare function createMockHost(config?: MockHostConfig): MockHost;
/**
 * Genesis hashes the mock host serves, one distinct non-zero value per chain.
 *
 * Distinct matters: chain routing is keyed on the genesis hash, so equal
 * hashes make the chains indistinguishable and a chain-routed call resolves to
 * whichever entry is found first. Non-zero matters for the same reason -- an
 * all-zero hash is also the natural placeholder a caller passes by accident.
 */
export declare const MOCK_GENESIS: {
    readonly people: "0x1111111111111111111111111111111111111111111111111111111111111111";
    readonly bulletin: "0x2222222222222222222222222222222222222222222222222222222222222222";
    readonly assetHub: "0x3333333333333333333333333333333333333333333333333333333333333333";
};
/**
 * A default {@link ProductRuntimeConfig} for a mock host. Override any field;
 * the genesis hashes and product id are placeholders suitable for tests.
 */
export declare function mockRuntimeConfig(overrides?: Partial<ProductRuntimeConfig>): ProductRuntimeConfig;
