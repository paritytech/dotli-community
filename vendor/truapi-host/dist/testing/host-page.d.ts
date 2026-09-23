import { type MockHost, type MockHostConfig } from "../web/create-mock-host.js";
import type { ProductRuntimeConfig } from "../runtime.js";
import { type DevAccount, type DevAccountName } from "./dev-accounts.js";
/**
 * Id the test host gives the product iframe.
 *
 * The Playwright fixture's `productFrame()` resolves against this, so the two
 * must agree; it is exported rather than duplicated as a string literal.
 */
export declare const PRODUCT_FRAME_ID = "product-frame";
/** Options for {@link startTestHost}. */
export interface TestHostPageOptions {
    /** URL of the product under test. */
    productUrl: string;
    /** Element the product iframe is appended to. */
    container: HTMLElement;
    /** Behaviour knobs forwarded to {@link createMockHost}. */
    mock?: MockHostConfig;
    /** Overrides merged into {@link mockRuntimeConfig}. */
    runtimeConfig?: Partial<ProductRuntimeConfig>;
    /**
     * Resolved WASM entry. Defaults to the signing-enabled `testing` bundle,
     * which is what lets the host own dev accounts instead of waiting on a
     * wallet that is not there.
     */
    wasmUrl?: string;
    /** Accounts the host can sign as. Defaults to `["alice"]`. */
    accounts?: (DevAccountName | DevAccount)[];
    /**
     * Whether the host activates a session at boot.
     *
     * `"auto"` (the default) starts signed in, which is what most suites want.
     * `"manual"` boots with no session so a test can drive the signed-out path;
     * call `switchAccount` to sign in.
     */
    loginBehavior?: LoginBehavior;
    /**
     * Where the core runs.
     *
     * `"worker"` (the default) matches production: web hosts run the core in a
     * Web Worker. `"main-thread"` keeps it on the page, which is simpler to
     * debug but is not a topology any real host uses.
     */
    topology?: "worker" | "main-thread";
    /** URL of the worker script. Defaults to what the test host server serves. */
    workerUrl?: string;
    /**
     * How resource allocation is answered.
     *
     * `"granted"` (the default) answers every request as allocated without
     * performing it, so a suite can exercise a product's allowance-dependent
     * paths with no on-chain personhood identity. Nothing is allocated: a green
     * run says the product handles a grant, not that a host would have given one.
     *
     * `"chain"` runs the real allocation -- ring membership, slot, proof,
     * extrinsic -- against the chains the host serves, and fails where a real
     * host would.
     */
    allowances?: "granted" | "chain";
    /**
     * Core log level (`off`/`error`/`warn`/`info`/`debug`/`trace`).
     *
     * The core logs why a call failed before mapping it to a protocol answer,
     * so raising this is what turns an opaque outcome into its reason. Under
     * `"worker"` those lines go to the worker console, which Playwright's
     * `page.on("console")` does not observe; pair this with
     * `topology: "main-thread"` to read them from a test.
     */
    logLevel?: string;
}
/** How the test host answers login at boot. */
export type LoginBehavior = "auto" | "manual";
/**
 * Account control, which lives on the runtime rather than the platform.
 *
 * A TrUAPI host derives accounts from session entropy, so switching account
 * means re-activating the session -- it is not a host callback the mock can
 * answer, which is why these sit alongside the mock's surface rather than in
 * it.
 */
export interface AccountControl {
    /** Names the host can currently sign as, in order. */
    getAccounts(): string[];
    /** The account the current session is activated from, if any. */
    getActiveAccount(): string | undefined;
    /**
     * Deliver a host-authored Chat action to the product, the way a posted
     * message or a tapped `Actions` button reaches it.
     *
     * Rejects when no product is connected: there is no stream to publish into.
     */
    injectChatAction(action: unknown): Promise<void>;
    /** Re-activate the session as `name`. */
    switchAccount(name: string): Promise<void>;
    /** Replace the roster, activating the first entry. */
    setAccounts(names: (DevAccountName | DevAccount)[]): Promise<void>;
    /** Drop the session, leaving the host signed out. */
    signOut(): Promise<void>;
}
/** What the fixture reaches on `window.__TRUAPI_TEST_HOST__`. */
export type TestHostControl = MockHost & AccountControl;
/** The running test host. */
export interface TestHostPage {
    /** The control surface the fixture reaches. */
    host: TestHostControl;
    /** The embedded product iframe. */
    iframe: HTMLIFrameElement;
    /** Tear down the iframe, the core and the channel. */
    dispose(): void;
}
declare global {
    interface Window {
        /** Published for the Playwright fixture; see the module comment. */
        __TRUAPI_TEST_HOST__?: TestHostControl;
        /**
         * The same object under the name `@parity/host-api-test-sdk` publishes.
         * A suite that drives the host page directly, rather than through the
         * fixture, reaches it here under whichever of the two names its
         * `page.evaluate` calls already use.
         */
        __TEST_HOST__?: TestHostControl;
    }
}
/**
 * Publish `control` under both global names, and return the undo.
 *
 * One object under two names, never a copy: a suite reaching the page through
 * either name drives the same mock, and two objects would let them drift.
 */
export declare function publishTestHostGlobals(control: TestHostControl): () => void;
/**
 * Boot the test host into `container` and publish its control surface.
 *
 * Resolves once the core is running and the product iframe has its port, so a
 * fixture that awaits this can assume the wire is live.
 */
export declare function startTestHost(options: TestHostPageOptions): Promise<TestHostPage>;
