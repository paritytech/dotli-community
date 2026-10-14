import type { TrUApiClient } from "@parity/truapi";
import { type MockHost, type MockHostConfig } from "../web/create-mock-host.js";
import type { ProductRuntimeConfig } from "../runtime.js";
import { type DevAccount, type DevAccountName } from "./dev-accounts.js";
/** Options for {@link createMockClient}. */
export interface MockClientOptions {
    /** Behaviour knobs forwarded to {@link createMockHost}. */
    mock?: MockHostConfig;
    /** Overrides merged into {@link mockRuntimeConfig}. */
    runtimeConfig?: Partial<ProductRuntimeConfig>;
    /** Account the host signs as. Defaults to `"alice"`. */
    account?: DevAccountName | DevAccount;
    /**
     * Resolved WASM entry.
     *
     * Defaults to the signing-enabled `testing` bundle resolved against this
     * module, which is what a product's own test run needs: unlike the browser
     * host page, there is no server here mapping `/wasm/` onto disk.
     */
    wasmUrl?: string;
}
/** A product client wired to a mock host, plus the mock for assertions. */
export interface MockClient {
    /** The client a product uses -- the same object it gets in production. */
    client: TrUApiClient;
    /** The mock host, exposing its recordings and control surface. */
    host: MockHost;
    /** Tear down the core, the channel and the client. */
    dispose(): void;
}
/**
 * Build a product client against a mock host and a real core.
 *
 * ```ts
 * const { client, host, dispose } = await createMockClient();
 * await client.navigation.navigateTo({ url: "https://example.invalid" });
 * expect(host.getNavigationLog()).toEqual(["https://example.invalid"]);
 * dispose();
 * ```
 */
export declare function createMockClient(options?: MockClientOptions): Promise<MockClient>;
