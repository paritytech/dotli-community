import type { MockHostConfig } from "../web/create-mock-host.js";
/** Host configuration the page understands. */
export interface HostPageConfig {
    /** URL of the product under test. */
    productUrl: string;
    /** dotNS identifier the host runs the product under. */
    productId?: string;
    /** Behaviour knobs forwarded to the mock host. */
    mock?: MockHostConfig;
    /** Overrides merged into the host's runtime config. */
    runtimeConfig?: Record<string, unknown>;
    /**
     * Accounts the host can sign as: a built-in name, or a name with the 32
     * bytes of entropy its session activates from.
     *
     * Explicit entropy is how a test signs as an identity the built-ins cannot
     * be -- one enrolled in a personhood ring, for instance, which allowance
     * allocation requires and a fixed dev account never satisfies.
     */
    accounts?: (string | {
        name: string;
        entropy: Uint8Array;
    })[];
    /** Whether the host starts signed in. */
    loginBehavior?: "auto" | "manual";
    /**
     * Where the core runs. `"worker"` is the production topology and the
     * default. `"main-thread"` is the debugging one: the core's log output
     * reaches the page console, where `page.on("console")` can read it, instead
     * of the worker console Playwright does not observe.
     */
    topology?: "worker" | "main-thread";
    /**
     * How resource allocation is answered: `"granted"` (the default) without
     * performing it, or `"chain"` for the real path.
     */
    allowances?: "granted" | "chain";
    /**
     * Core log level (`off`/`error`/`warn`/`info`/`debug`/`trace`). Raising it
     * is what turns a bare failure outcome into the reason behind it: the core
     * logs why a call failed before mapping it to a protocol answer.
     */
    logLevel?: string;
}
/** Apply `config` to a host page URL, returning the configured URL. */
export declare function hostPageUrl(base: string, config: HostPageConfig): string;
