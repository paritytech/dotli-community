import type { Page, FrameLocator } from "@playwright/test";
import type { ChainStatus, ChatMessageRecord, MockHostConfig, NotificationLogEntry, PermissionLogEntry, PermissionPolicy, SigningLogEntry } from "../web/create-mock-host.js";
export { DEFAULT_CHAIN, DEV_ACCOUNTS, LIVE_CHAINS, PASEO_ASSET_HUB, liveChain, } from "./dev-accounts.js";
export { DEV_ACCOUNT_NAMES } from "./dev-accounts.js";
export type { DevAccount, DevAccountName } from "./dev-accounts.js";
export type { ChatMessageRecord as ChatMessageLogEntry, NotificationLogEntry, PermissionLogEntry, PermissionPolicy as PermissionBehavior, SigningLogEntry, } from "../web/create-mock-host.js";
export type { LoginBehavior } from "./host-page.js";
/** Options for {@link createTestHostFixture}. */
export interface TestHostFixtureOptions {
    /** URL of the product under test. */
    productUrl: string;
    /**
     * Base URL of a running host page server.
     *
     * Optional. Omit it and the fixture starts one itself, lazily, and shares it
     * across every test in the file -- bundling is not cached, so one server per
     * test would pay esbuild each time. Supply it to control the lifetime.
     */
    hostUrl?: string;
    /**
     * Chains to serve, in `@parity/host-api-test-sdk`'s `NetworkConfig` shape.
     *
     * A convenience over spelling out `mock.chainProxies`, `mock.supportedChains`
     * and `runtimeConfig` separately, which have to agree. The chain's role is
     * read from the `id` suffix (`-asset-hub`, `-people`, `-bulletin`, else the
     * relay) and the rest of the id is the network name.
     *
     * Explicit `mock` or `runtimeConfig` values win, so a suite can start here
     * and override one piece.
     */
    networks?: NetworkConfig[];
    /**
     * A single chain, as older `@parity/host-api-test-sdk` versions spell it.
     *
     * Exactly `networks: [chain]`, under the name that vintage uses. Passing
     * both is refused rather than merged, because guessing which one the author
     * meant is worse than saying so.
     */
    chain?: NetworkConfig;
    /**
     * Accepted only to fail with an explanation. See the error text: TrUAPI
     * derives a product account from the session root, so it cannot be pinned.
     */
    productAccounts?: Record<string, string>;
    /**
     * dotNS identifier the host runs the product under.
     *
     * Must match the identifier the product signs with: the core rejects a
     * signing request whose account is scoped to a different product, so a
     * mismatch surfaces as `PermissionDenied` rather than as a config error.
     */
    productId?: string;
    /** Behaviour knobs forwarded to the mock host, including `chainProxies`. */
    mock?: MockHostConfig;
    /**
     * Overrides merged into the host's runtime config.
     *
     * Proxying a real chain needs this: the core asks for a chain by the genesis
     * hash the config declares, so that hash has to be the real one rather than
     * a {@link MOCK_GENESIS} placeholder.
     */
    runtimeConfig?: Record<string, unknown>;
    /**
     * Accounts the host can sign as. Defaults to `["alice"]`.
     *
     * Objects are accepted for `@parity/host-api-test-sdk` compatibility, but a
     * `uri` is rejected: a TrUAPI session activates from 32 bytes of entropy,
     * not a `//Alice`-style derivation path.
     */
    accounts?: (string | {
        name: string;
        uri?: string;
        entropy?: Uint8Array;
    })[];
    /** Whether the host starts signed in. Defaults to `"auto"`. */
    loginBehavior?: "auto" | "manual";
    /**
     * Where the core runs. Defaults to `"worker"`, the production topology.
     *
     * Switch to `"main-thread"` to debug: the core's log output then reaches the
     * page console, where `page.on("console")` can read it. Under `"worker"` it
     * goes to the worker console, which Playwright does not observe -- so a
     * failing call looks like a bare outcome with no reason attached.
     */
    topology?: "worker" | "main-thread";
    /**
     * How resource allocation is answered. Defaults to `"granted"`.
     *
     * `"granted"` answers every request as allocated without performing it, so a
     * suite exercises its product's allowance-dependent paths with no on-chain
     * personhood identity. Nothing is allocated, so a pass says the product
     * handles a grant, not that a host would have given one.
     *
     * `"chain"` runs the real allocation against the chains the host serves:
     * ring membership, slot selection, proof and extrinsic. It fails where a
     * real host would, which is the point of choosing it.
     */
    allowances?: "granted" | "chain";
    /**
     * Serve the statement store in-page instead of forwarding it to the chains
     * the host proxies. Defaults to on when `allowances` is `"granted"`, so the
     * two halves of a statement flow agree: a product that is handed an
     * unregistered allowance key can still submit with it.
     *
     * Nothing submitted this way leaves the page, and a real store would refuse
     * it. Set `false` to send statements to the chain and see what it says.
     */
    loopbackStatements?: boolean;
    /**
     * Core log level (`off`/`error`/`warn`/`info`/`debug`/`trace`).
     *
     * The core logs why a call failed before mapping it to a protocol answer,
     * so this is what turns an opaque outcome into its cause. Pair it with
     * `topology: "main-thread"` to read those lines from a test.
     */
    logLevel?: string;
    /** How long to wait for the host page to publish its control surface. */
    readyTimeoutMs?: number;
}
/** The fixture a test receives. */
export interface TestHost {
    /** The Playwright page running the host. */
    page: Page;
    /** Locator for the embedded product. */
    productFrame(): FrameLocator;
    getNavigationLog(): Promise<string[]>;
    clearNavigationLog(): Promise<void>;
    getNotificationLog(): Promise<NotificationLogEntry[]>;
    clearNotificationLog(): Promise<void>;
    getSigningLog(): Promise<SigningLogEntry[]>;
    clearSigningLog(): Promise<void>;
    getPermissionLog(): Promise<PermissionLogEntry[]>;
    clearPermissionLog(): Promise<void>;
    getGrantedPermissions(): Promise<string[]>;
    grantPermission(permission: string): Promise<void>;
    revokePermission(permission: string): Promise<void>;
    setEnforcePermissions(enforce: boolean): Promise<void>;
    setPermissionBehavior(behavior: PermissionPolicy): Promise<void>;
    getChatRooms(): Promise<unknown[]>;
    getChatBots(): Promise<unknown[]>;
    getChatMessageLog(): Promise<ChatMessageRecord[]>;
    clearChatState(): Promise<void>;
    /** Product-scoped storage the core has written, keyed without the prefix. */
    getProductStorage(): Promise<Record<string, Uint8Array>>;
    getPreimages(): Promise<Uint8Array[]>;
    seedPreimage(value: Uint8Array): Promise<Uint8Array>;
    /**
     * Find the value the product stored under `key`.
     *
     * The core namespaces product storage keys before the host ever sees them,
     * so a test matching on the product's own key wants a suffix match rather
     * than the full namespaced string, which is an internal shape.
     */
    findProductStorage(key: string): Promise<Uint8Array | undefined>;
    clearPreimages(): Promise<void>;
    getTheme(): Promise<string>;
    setTheme(variant: string): Promise<void>;
    getIsAuthenticated(): Promise<boolean>;
    getChainStatus(): Promise<ChainStatus>;
    getConnectionStatus(): Promise<ChainStatus>;
    /**
     * Raw JSON-RPC the core sent over the chain connection, in order.
     *
     * A chain-path failure is otherwise invisible from a suite: the product
     * shows a stalled UI and the fixture reports nothing about what the host
     * asked the chain. This is what tells you whether a request was made at
     * all, and what came back after it.
     */
    getSentRpc(): Promise<string[]>;
    /** Drop the recorded RPC, so one case does not read another's traffic. */
    clearSentRpc(): Promise<void>;
    simulateDisconnect(): Promise<void>;
    simulateReconnect(): Promise<void>;
    /**
     * Wait until the product has an open channel to the host.
     *
     * Resolves once the core has answered at least one product call, which is
     * the first observable evidence that frames are crossing the wire in both
     * directions.
     */
    waitForConnection(timeoutMs?: number): Promise<void>;
    /** Names the host can currently sign as. */
    getAccounts(): Promise<string[]>;
    /** The account the current session is activated from, if any. */
    getActiveAccount(): Promise<string | undefined>;
    /** Re-activate the session as `name`. */
    switchAccount(name: string): Promise<void>;
    /** Replace the roster, activating the first entry. */
    setAccounts(names: string[]): Promise<void>;
    /** Drop the session, leaving the host signed out. */
    signOut(): Promise<void>;
    /** Return the host to its constructed state between cases. */
    reset(): Promise<void>;
    /**
     * Statements the product submitted.
     *
     * Always throws. The statement store is core-owned and submission is
     * rejected inside the core before any RPC is emitted, so there is nothing
     * for the host to record -- not a host seam the mock declined to implement.
     */
    /**
     * Statements the product submitted, as `0x` hex, read off the chain
     * transport rather than a host-side log.
     *
     * Empty for a product that asks the host to sign
     * (`createProofAuthorized`): that needs a statement allowance, and without
     * one no statement is ever built to submit. A product that signs its own
     * statements is observable here.
     */
    getSubmittedStatements(): Promise<string[]>;
    /**
     * Deliver a statement to the product as a chain notification, returning how
     * many live subscriptions it reached. Subscribe first: zero means nothing
     * was listening.
     */
    injectStatement(statement: Uint8Array | string): Promise<number>;
    /** Statements injected so far, in order. */
    getInjectedStatements(): Promise<string[]>;
    /** Forget the injected statements. */
    clearStatements(): Promise<void>;
    /**
     * Release the host.
     *
     * A no-op. Playwright owns the page's lifetime and closes it when the test
     * ends, so a suite has nothing to release. Declared because
     * `@parity/host-api-test-sdk`'s surface has it, so a teardown call written
     * against that surface is still valid here.
     */
    dispose(): Promise<void>;
    /** Set the spendable balance. Always throws; payments are unimplemented. */
    setPaymentBalance(amount: bigint): Promise<never>;
    /** Payment operations the product performed. Always throws; see above. */
    getPaymentLog(): Promise<never>;
    /** Drop the payment log. Always throws; see above. */
    clearPaymentLog(): Promise<never>;
    /** How top-ups resolve. Always throws; see above. */
    setPaymentTopUpBehavior(behavior: unknown): Promise<never>;
    /** Force a payment's status. Always throws; see above. */
    simulatePaymentStatus(paymentId: string, status: {
        tag: string;
        value?: string;
    }): Promise<never>;
    /**
     * Deliver a peer's activation of a chat action to the product.
     *
     * Always throws. `ChatPlatform` is create/register/post/subscribe-rooms only,
     * so a peer activating an action has no way into the core. `ChatAction`
     * exists as message *content* a product posts, not as an inbound event.
     */
    /**
     * Deliver a host-authored Chat action to the product -- the path a posted
     * message or a tapped `Actions` button takes back to it.
     *
     * Takes the `HostChatActionSubscribeItem` the core publishes, not
     * `@parity/host-api-test-sdk`'s `{roomId, peer, payload}`: this goes through
     * the core's own action stream, so it carries the core's value.
     */
    injectChatAction(action: unknown): Promise<void>;
    /**
     * Change the login behaviour after boot.
     *
     * Always throws, and says what to do instead: the host page reads it once at
     * start, so it is a `loginBehavior` option on `createTestHostFixture`.
     */
    setLoginBehavior(behavior: "auto" | "manual"): Promise<never>;
}
/** One chain, in `@parity/host-api-test-sdk`'s shape. */
export interface NetworkConfig {
    /** e.g. `paseo-asset-hub`; the suffix names the chain's role. */
    id: string;
    name?: string;
    genesisHash: string;
    rpcUrl: string;
    tokenSymbol?: string;
    tokenDecimals?: number;
}
/**
 * Expand `networks` into the three settings that have to agree.
 *
 * A single proxy carries no genesis hash: an unhashed proxy takes every
 * request, so routing survives a chain reset while only the DECLARED hash --
 * which the product checks against its descriptor bundle -- needs re-pinning.
 *
 * Several proxies have to be hashed, because an unhashed one would answer the
 * other chain's requests too. That is not hypothetical: with a hub and a People
 * chain both unhashed, the hub took the People reads and allowance registration
 * failed looking for personhood collections on a chain that has none.
 */
export declare function fromNetworks(networks: NetworkConfig[], loopbackStatements?: boolean): {
    mock: Pick<MockHostConfig, "chainProxies" | "supportedChains">;
    runtimeConfig: Record<string, unknown>;
};
/**
 * Build the `testHost` fixture.
 *
 * ```ts
 * export const test = base.extend(createTestHostFixture({
 *   productUrl: "http://127.0.0.1:5173",
 *   hostUrl: server.url,
 * }));
 * ```
 */
export declare function createTestHostFixture(defaults: TestHostFixtureOptions): {
    testHost: ({ page }: {
        page: Page;
    }, use: (fixture: TestHost) => Promise<void>) => Promise<void>;
};
