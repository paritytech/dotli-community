// Browser half of the test host: the page a Playwright fixture drives.
//
// It embeds the product in an iframe, runs a real truapi-server core against
// `createMockHost`'s callbacks, and publishes the mock's control surface on
// `window.__TRUAPI_TEST_HOST__` so the fixture can reach it through
// `page.evaluate`.
//
//   Playwright (node)                    this page (browser)
//   +------------------+                 +----------------------------------+
//   | fixture          |  page.evaluate  | window.__TRUAPI_TEST_HOST__      |
//   | testHost.*       |---------------->| createMockHost() control surface |
//   +------------------+                 +----------------------------------+
//                                             ^ callbacks
//                                        +----------------------------------+
//                                        | truapi-server WASM core          |
//                                        +----------------------------------+
//                                             ^ SCALE frames over MessagePort
//                                        +----------------------------------+
//                                        | product iframe (#product-frame)  |
//                                        +----------------------------------+
//
// The core runs on the page's main thread rather than in a Worker: a test host
// has no UI to keep responsive, and one less moving part is one less thing to
// debug when a suite fails.
import { createIframeHost } from "../web/create-iframe-host.js";
import { createWebWorkerSigningHostRuntime } from "../web/create-worker-host-runtime.js";
import { createMockHost, mockRuntimeConfig, } from "../web/create-mock-host.js";
import { resolveAccount, } from "./dev-accounts.js";
/**
 * Id the test host gives the product iframe.
 *
 * The Playwright fixture's `productFrame()` resolves against this, so the two
 * must agree; it is exported rather than duplicated as a string literal.
 */
export const PRODUCT_FRAME_ID = "product-frame";
/**
 * Publish `control` under both global names, and return the undo.
 *
 * One object under two names, never a copy: a suite reaching the page through
 * either name drives the same mock, and two objects would let them drift.
 */
export function publishTestHostGlobals(control) {
    window.__TRUAPI_TEST_HOST__ = control;
    window.__TEST_HOST__ = control;
    return () => {
        delete window.__TRUAPI_TEST_HOST__;
        delete window.__TEST_HOST__;
    };
}
/**
 * Boot the test host into `container` and publish its control surface.
 *
 * Resolves once the core is running and the product iframe has its port, so a
 * fixture that awaits this can assume the wire is live.
 */
export async function startTestHost(options) {
    const host = createMockHost(options.mock);
    const { productId, ...hostConfig } = mockRuntimeConfig(options.runtimeConfig ?? {});
    // A signing host, not a pairing host: a test host owns its keys. Note the
    // behavioural consequence -- a signing host answers `request_login` with
    // AlreadyConnected instead of starting a pairing flow, so a suite asserting
    // on pairing UI is asserting on a host role this is not.
    let worker;
    // Exactly one of these is set; which one is the topology.
    let workerRuntime;
    let directRuntime;
    let runtime;
    if ((options.topology ?? "worker") === "worker") {
        // Production topology: the core runs in a Web Worker, reached over the
        // same protocol a real web host uses.
        worker = new Worker(options.workerUrl ?? "/test-host-worker.js", {
            type: "module",
        });
        workerRuntime = (await createWebWorkerSigningHostRuntime(worker, host.callbacks, { hostConfig: hostConfig, role: "signing" }));
        if (options.logLevel)
            workerRuntime.setLogLevel?.(options.logLevel);
        if ((options.allowances ?? "granted") === "granted") {
            await workerRuntime.setGrantAllowancesUnchecked?.(true);
        }
        runtime = workerRuntime;
    }
    else {
        const wasmUrl = options.wasmUrl ?? "./wasm/testing/truapi_server.js";
        const glue = (await import(/* @vite-ignore */ wasmUrl));
        await glue.default();
        if (options.logLevel)
            glue.setLogLevel?.(options.logLevel);
        const { createWasmRawCallbacks } = await import("../generated/host-callbacks-adapter.js");
        directRuntime = new glue.WasmSigningHostRuntime({
            // A raw bridge callback rather than a generated host callback, so it
            // is supplied here the way the worker runtime does. The test host runs
            // one product and starts no workers.
            ...createWasmRawCallbacks(host.callbacks),
            workerDemandChanged: () => { },
        }, hostConfig);
        // The direct core takes a name through a separate entry point, so the
        // shared `activate` above cannot call it directly. Adapt here rather than
        // branching there, so both topologies activate identically.
        if ((options.allowances ?? "granted") === "granted") {
            directRuntime.setGrantAllowancesUnchecked?.(true);
        }
        const direct = directRuntime;
        runtime = {
            activateLocalSession(secret, liteUsername) {
                if (liteUsername !== undefined &&
                    typeof direct.activateLocalSessionWithIdentity === "function") {
                    return direct.activateLocalSessionWithIdentity(secret, liteUsername);
                }
                return direct.activateLocalSession(secret);
            },
            disconnectSession: () => direct.disconnectSession(),
        };
    }
    let roster = (options.accounts ?? ["alice"]).map(resolveAccount);
    let active;
    const activate = async (account) => {
        if (active)
            await runtime.disconnectSession();
        // Named, not anonymous: a session with no username makes
        // `account.get_user_id` answer `Unknown`, where a real host names the
        // signed-in identity. The name is the account's, which is what
        // `@parity/host-api-test-sdk` answers with too.
        await runtime.activateLocalSession(account.entropy, account.name);
        active = account;
    };
    if ((options.loginBehavior ?? "auto") === "auto") {
        const first = roster[0];
        if (!first)
            throw new Error("test host needs at least one account");
        await activate(first);
    }
    // The core and the product each hold one end of a MessageChannel. Frames are
    // raw SCALE bytes in both directions; nothing interprets them here.
    //
    // The two topologies expose the core differently -- a worker hands back a
    // wire provider, the main thread hands back a product core -- so each is
    // normalised to the same "pipe this port" step.
    let detach;
    // Set when the product connects, by whichever topology is running.
    let publishChatAction;
    const iframeHost = createIframeHost({
        iframeUrl: options.productUrl,
        container: options.container,
        onPort(port) {
            void (async () => {
                if (workerRuntime) {
                    const provider = await workerRuntime.createProvider({ productId });
                    const unsubscribe = provider.subscribe((frame) => {
                        port.postMessage(frame);
                    });
                    port.onmessage = (event) => {
                        const frame = event.data;
                        if (frame instanceof Uint8Array)
                            provider.postMessage(frame);
                    };
                    publishChatAction = provider.publishChatAction
                        ? (action) => provider.publishChatAction(action)
                        : undefined;
                    detach = () => {
                        unsubscribe();
                        publishChatAction = undefined;
                        provider.dispose();
                    };
                }
                else {
                    const core = directRuntime.productRuntime({ productId }, {
                        emitFrame(frame) {
                            port.postMessage(frame);
                        },
                    });
                    port.onmessage = (event) => {
                        const frame = event.data;
                        if (frame instanceof Uint8Array)
                            void core.receiveFrame(frame);
                    };
                    // The direct core takes bytes, so the value is encoded here rather
                    // than inside the provider.
                    publishChatAction = core.publishChatAction
                        ? async (action) => {
                            const { HostChatActionSubscribeItem } = await import("@parity/truapi");
                            core.publishChatAction(HostChatActionSubscribeItem.enc(action));
                        }
                        : undefined;
                    detach = () => {
                        publishChatAction = undefined;
                        core.dispose();
                    };
                }
                port.start();
            })();
        },
    });
    const control = Object.assign(host, {
        getAccounts: () => roster.map((account) => account.name),
        getActiveAccount: () => active?.name,
        injectChatAction: async (action) => {
            if (!publishChatAction) {
                throw new Error("no product is connected, so there is no Chat action stream to " +
                    "publish into; wait for the product frame before injecting");
            }
            await publishChatAction(action);
        },
        async switchAccount(name) {
            const account = roster.find((entry) => entry.name === name);
            if (!account) {
                throw new Error(`no account "${name}" on this host; have ${roster
                    .map((entry) => entry.name)
                    .join(", ")}`);
            }
            await activate(account);
        },
        async setAccounts(names) {
            roster = names.map(resolveAccount);
            const first = roster[0];
            if (!first)
                throw new Error("test host needs at least one account");
            await activate(first);
        },
        async signOut() {
            if (!active)
                return;
            await runtime.disconnectSession();
            active = undefined;
        },
    });
    // The fixture locates the product by id. `createIframeHost` does not set
    // one -- a production host has no reason to -- so the test host does.
    iframeHost.iframe.id = PRODUCT_FRAME_ID;
    const unpublish = publishTestHostGlobals(control);
    return {
        host: control,
        iframe: iframeHost.iframe,
        dispose() {
            unpublish();
            detach?.();
            iframeHost.dispose();
            worker?.terminate();
            host.dispose();
        },
    };
}
