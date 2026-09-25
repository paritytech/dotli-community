// One call to get a product client talking to a real core over a mocked host.
//
// The Playwright fixture drives a product that lives in an iframe, which is
// what an end-to-end suite needs. This is the other shape: no iframe, no
// browser automation, both ends of the wire in one process. A product's own
// unit tests get a `TrUApiClient` that behaves like the production one --
// same transport, same SCALE frames, same dispatcher -- with the host seam
// mocked underneath and its recordings available for assertions.
//
//   client  --MessagePort-->  core (WASM)  -->  createMockHost callbacks
//     ^                                              |
//     +---------------- assertions on ---------------+
//
// It uses a real `MessageChannel`, so the wire is the production transport
// rather than a direct function call. What it does NOT exercise is the iframe
// boundary and the browser's origin checks; the fixture covers those.
import { createClient, createMessagePortProvider, createTransport } from "@parity/truapi";
import { createMockHost, mockRuntimeConfig, } from "../web/create-mock-host.js";
import { resolveAccount } from "./dev-accounts.js";
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
export async function createMockClient(options = {}) {
    const wasmUrl = options.wasmUrl ??
        new URL("../../dist/wasm/testing/truapi_server.js", import.meta.url).href;
    const glue = (await import(/* @vite-ignore */ wasmUrl));
    await glue.default();
    const { createWasmRawCallbacks } = await import("../generated/host-callbacks-adapter.js");
    const host = createMockHost(options.mock);
    const { productId, ...hostConfig } = mockRuntimeConfig(options.runtimeConfig ?? {});
    const runtime = new glue.WasmSigningHostRuntime({
        // Supplied outside the generated adapter, as the worker runtime does.
        ...createWasmRawCallbacks(host.callbacks),
        workerDemandChanged: () => { },
    }, hostConfig);
    const account = resolveAccount(options.account ?? "alice");
    await runtime.activateLocalSession(account.entropy);
    // Both ends in one process, but still over a real MessagePort: the frames
    // crossing here are the same bytes that cross an iframe boundary.
    const channel = new MessageChannel();
    const core = runtime.productRuntime({ productId }, {
        emitFrame(frame) {
            channel.port1.postMessage(frame);
        },
    });
    channel.port1.onmessage = (event) => {
        const frame = event.data;
        if (frame instanceof Uint8Array)
            void core.receiveFrame(frame);
    };
    channel.port1.start();
    const provider = createMessagePortProvider(channel.port2);
    const transport = createTransport(provider);
    const client = createClient(transport);
    return {
        client,
        host,
        dispose() {
            provider.dispose();
            core.dispose();
            channel.port1.close();
            channel.port2.close();
        },
    };
}
