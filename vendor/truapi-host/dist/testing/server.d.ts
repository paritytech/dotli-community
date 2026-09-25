import type { HostPageConfig } from "./host-page-url.js";
/** Options for {@link createTestHostServer}. */
export interface TestHostServerOptions extends Partial<HostPageConfig> {
    /** Port to listen on. `0` (the default) picks a free one. */
    port?: number;
    /**
     * Accepted only to fail with an explanation: TrUAPI derives a product
     * account from (session root, product id), so it cannot be mapped to a
     * chosen one. See the error text for what to do instead.
     */
    productAccounts?: Record<string, unknown>;
    /**
     * Do not keep the process alive for this server.
     *
     * Set when the fixture starts the server itself: nothing then calls `close`,
     * and a referenced listener would stall worker exit at the end of a run.
     */
    unref?: boolean;
}
/** A running test host server. */
export interface TestHostServer {
    /**
     * URL to open. Carries whatever host configuration was passed here; with no
     * configuration it is the bare base the fixture appends its own to.
     */
    url: string;
    /** Stop listening. */
    close(): Promise<void>;
}
/**
 * Start the test host server.
 *
 * ```ts
 * const server = await createTestHostServer();
 * const test = base.extend(createTestHostFixture({
 *   productUrl: "http://127.0.0.1:5173",
 *   hostUrl: server.url,
 * }));
 * ```
 */
export declare function createTestHostServer(options?: TestHostServerOptions): Promise<TestHostServer>;
