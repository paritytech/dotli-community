// Playwright fixture over the test host.
//
// The node half of the pair described in `host-page.ts`: every method here is
// a `page.evaluate` against `window.__TRUAPI_TEST_HOST__`, so the control
// surface a test drives is the same object the core is answering through.
//
// The method names are `@parity/host-api-test-sdk`'s `TestHost` names, so a
// suite written against either reads the same. Where a name is absent it is
// because TrUAPI has no seam for it -- see `notModeled` in
// `create-mock-host.ts`; those throw rather than silently pass.
import { PRODUCT_FRAME_ID } from "./host-page.js";
import { createTestHostServer } from "./server.js";
import { hostPageUrl } from "./host-page-url.js";
// Re-exported so a test file imports the fixture and the chain constants from
// one path, the way `@parity/host-api-test-sdk/playwright` does.
export { DEFAULT_CHAIN, DEV_ACCOUNTS, LIVE_CHAINS, PASEO_ASSET_HUB, liveChain, } from "./dev-accounts.js";
export { DEV_ACCOUNT_NAMES } from "./dev-accounts.js";
/** Selector for the product iframe the host page creates. */
const PRODUCT_FRAME = `#${PRODUCT_FRAME_ID}`;
/**
 * Why the payment controls cannot be served.
 *
 * Not a seam the mock declined to implement: every method in the core's
 * `capabilities/payment.rs` returns an error and ignores its arguments, so
 * there is no behaviour for a host to model or a test to observe.
 */
const NO_PAYMENT_SEAM = "is not available in the TrUAPI test host: the protocol declares payments " +
    "but no host implements them -- every method in the core's payment " +
    "capability returns an error and ignores its arguments, so there is nothing " +
    "to record or simulate. See docs/rfcs/0006-payments.md.";
/** Why login behaviour is fixed once the host page has booted. */
const LOGIN_BEHAVIOR_IS_CONSTRUCTION_TIME = "cannot be changed after boot in the TrUAPI test host: the host page reads " +
    "it once at start. Pass `loginBehavior: \"auto\" | \"manual\"` to " +
    "createTestHostFixture instead.";
/** Why a product account cannot be pinned to a chosen key. */
const NO_PINNED_PRODUCT_ACCOUNT = "is not supported by the TrUAPI test host: a product account is DERIVED " +
    "from (session root, product id), so it cannot be mapped to a chosen dev " +
    "account. `@parity/host-api-test-sdk` could pin one because it reimplements " +
    "the protocol with no core behind it. Read the address back from the host " +
    "instead of pinning it, and expect `switchAccount` to change it: the next " +
    "call derives from the new session root, with no reconnect needed. That is " +
    "the real behaviour, not a test-host limitation.";
/** Why a derivation URI cannot name an account. */
const NO_DERIVATION_URI = "is not supported by the TrUAPI test host: a session activates from 32 " +
    "bytes of BIP-39 entropy, not a `//Alice`-style derivation path, so the " +
    "addresses differ from polkadot-js's by construction. Use a built-in name " +
    "(alice, bob, charlie, dave) or pass explicit entropy.";
/** Role and network implied by a `NetworkConfig.id`. */
function splitChainId(id) {
    const suffixes = [
        ["-asset-hub", "AssetHub", "assetHub"],
        ["-people", "People", "people"],
        ["-bulletin", "Bulletin", "bulletin"],
    ];
    for (const [suffix, identifier, configKey] of suffixes) {
        if (id.endsWith(suffix)) {
            return { network: id.slice(0, -suffix.length), identifier, configKey };
        }
    }
    // No suffix: the id names the network and the chain is its relay. The
    // runtime config has no relay slot, so there is no key to declare it under.
    return { network: id, identifier: "Relay" };
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
export function fromNetworks(networks, loopbackStatements = false) {
    const runtimeConfig = {};
    const chains = [];
    let network = "paseo";
    for (const entry of networks) {
        const split = splitChainId(entry.id);
        network = split.network || network;
        chains.push({
            identifier: split.identifier,
            genesisHash: entry.genesisHash,
        });
        if (split.configKey) {
            runtimeConfig[split.configKey] = { genesisHash: entry.genesisHash };
        }
    }
    return {
        mock: {
            chainProxies: networks.map((entry) => ({
                ...(networks.length > 1 ? { genesisHash: entry.genesisHash } : {}),
                rpcUrl: entry.rpcUrl,
                // Only the People chain carries the statement store, so serving it
                // locally on the hub as well would claim a store where none exists.
                ...(loopbackStatements && splitChainId(entry.id).identifier === "People"
                    ? { loopbackStatements: true }
                    : {}),
            })),
            supportedChains: { network, chains },
        },
        runtimeConfig,
    };
}
/** Account names for the page URL, rejecting anything the host cannot honour. */
function accountNames(accounts) {
    return accounts.map((account) => {
        if (typeof account === "string")
            return account;
        if (account.uri !== undefined) {
            throw new Error(`testHost account "${account.name}": \`uri\` ${NO_DERIVATION_URI}`);
        }
        // Entropy is carried through rather than reduced to a name: it is the only
        // way to sign as an identity that is not one of the built-ins.
        if (account.entropy !== undefined) {
            if (account.entropy.length !== 32) {
                throw new Error(`testHost account "${account.name}": entropy must be 32 bytes, got ${account.entropy.length}`);
            }
            return { name: account.name, entropy: account.entropy };
        }
        return account.name;
    });
}
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
export function createTestHostFixture(defaults) {
    if (defaults.productAccounts) {
        throw new Error(`testHost \`productAccounts\` ${NO_PINNED_PRODUCT_ACCOUNT}`);
    }
    // Started at most once and shared by every test in the file. Held as the
    // promise, not the server, so concurrent first tests await one start rather
    // than racing two.
    // Validated here rather than in the fixture body: a bad option should fail
    // when the suite is constructed, not inside the first test that runs.
    const accounts = defaults.accounts
        ? accountNames(defaults.accounts)
        : undefined;
    let ownServer;
    const hostBase = async () => {
        if (defaults.hostUrl)
            return defaults.hostUrl;
        ownServer ??= createTestHostServer({ unref: true });
        return (await ownServer).url;
    };
    if (defaults.chain && defaults.networks) {
        throw new Error("testHost fixture: pass either `chain` (one chain, the older " +
            "`@parity/host-api-test-sdk` spelling) or `networks` (several), not " +
            "both -- `chain: x` is exactly `networks: [x]`.");
    }
    const chains = defaults.networks ?? (defaults.chain ? [defaults.chain] : undefined);
    // Defaults to on when allocation is granted unchecked, so a product handed
    // an unregistered allowance key has somewhere its statements are accepted.
    const loopbackStatements = defaults.loopbackStatements ?? (defaults.allowances ?? "granted") === "granted";
    const expanded = chains
        ? fromNetworks(chains, loopbackStatements)
        : undefined;
    // Explicit settings win over anything derived from `networks`.
    const mock = expanded ? { ...expanded.mock, ...defaults.mock } : defaults.mock;
    const runtimeConfig = expanded
        ? { ...expanded.runtimeConfig, ...defaults.runtimeConfig }
        : defaults.runtimeConfig;
    return {
        testHost: async ({ page }, use) => {
            const url = hostPageUrl(await hostBase(), {
                productUrl: defaults.productUrl,
                productId: defaults.productId,
                mock,
                runtimeConfig,
                accounts,
                loginBehavior: defaults.loginBehavior,
                topology: defaults.topology,
                allowances: defaults.allowances,
                logLevel: defaults.logLevel,
            });
            await page.goto(url);
            // The page publishes its control surface only once the WASM core is up
            // and the product has its port, so this doubles as the wire's ready gate.
            await page.waitForFunction(() => !!window.__TRUAPI_TEST_HOST__, {
                timeout: defaults.readyTimeoutMs ?? 30_000,
            });
            /** Call one control method in the page and return its result. */
            const call = (method, ...args) => page.evaluate(([name, callArgs]) => {
                const host = window.__TRUAPI_TEST_HOST__;
                if (!host)
                    throw new Error("test host is not running on this page");
                const fn = host[name];
                if (typeof fn !== "function") {
                    throw new Error(`test host has no control method ${name}`);
                }
                return fn.apply(host, callArgs);
            }, [method, args]);
            const testHost = {
                page,
                productFrame: () => page.frameLocator(PRODUCT_FRAME),
                getNavigationLog: () => call("getNavigationLog"),
                clearNavigationLog: () => call("clearNavigationLog"),
                getNotificationLog: () => call("getNotificationLog"),
                clearNotificationLog: () => call("clearNotificationLog"),
                getSigningLog: () => call("getSigningLog"),
                clearSigningLog: () => call("clearSigningLog"),
                getPermissionLog: () => call("getPermissionLog"),
                clearPermissionLog: () => call("clearPermissionLog"),
                getGrantedPermissions: () => call("getGrantedPermissions"),
                grantPermission: (permission) => call("grantPermission", permission),
                revokePermission: (permission) => call("revokePermission", permission),
                setEnforcePermissions: (enforce) => call("setEnforcePermissions", enforce),
                setPermissionBehavior: (behavior) => call("setPermissionBehavior", behavior),
                getChatRooms: () => call("getChatRooms"),
                getChatBots: () => call("getChatBots"),
                getChatMessageLog: () => call("getChatMessageLog"),
                clearChatState: () => call("clearChatState"),
                // `page.evaluate` serialises a Uint8Array as a plain index object, so
                // binary values are converted to arrays in the page and rebuilt here.
                // Without this a caller gets `{0: 114, …}` and any decode of it
                // silently yields "".
                getProductStorage: async () => {
                    const raw = await page.evaluate(() => {
                        const host = window.__TRUAPI_TEST_HOST__;
                        if (!host)
                            throw new Error("test host is not running on this page");
                        return Object.fromEntries(Object.entries(host.getProductStorage()).map(([key, value]) => [
                            key,
                            Array.from(value),
                        ]));
                    });
                    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [
                        key,
                        Uint8Array.from(value),
                    ]));
                },
                async findProductStorage(key) {
                    const stored = await testHost.getProductStorage();
                    const match = Object.entries(stored).find(([stored]) => stored.endsWith(`:${key}`));
                    return match?.[1];
                },
                getPreimages: async () => {
                    const raw = await page.evaluate(() => {
                        const host = window.__TRUAPI_TEST_HOST__;
                        if (!host)
                            throw new Error("test host is not running on this page");
                        return host.getPreimages().map((value) => Array.from(value));
                    });
                    return raw.map((value) => Uint8Array.from(value));
                },
                seedPreimage: (value) => call("seedPreimage", value),
                clearPreimages: () => call("clearPreimages"),
                getTheme: () => call("getTheme"),
                setTheme: (variant) => call("setTheme", variant),
                getIsAuthenticated: () => call("getIsAuthenticated"),
                getChainStatus: () => call("getChainStatus"),
                getConnectionStatus: () => call("getConnectionStatus"),
                getSentRpc: () => call("sentRpc"),
                clearSentRpc: () => call("clearSentRpc"),
                simulateDisconnect: () => call("simulateDisconnect"),
                simulateReconnect: () => call("simulateReconnect"),
                async waitForConnection(timeoutMs = 30_000) {
                    // A live wire means the core has actually called the host, not
                    // merely that the page finished loading.
                    await page.waitForFunction(() => (window.__TRUAPI_TEST_HOST__?.getHostCallCount() ?? 0) > 0, { timeout: timeoutMs });
                },
                getAccounts: () => call("getAccounts"),
                getActiveAccount: () => call("getActiveAccount"),
                // Switching account re-activates the session, which reloads the
                // product iframe; wait for it so the next action does not race it.
                switchAccount: async (name) => {
                    await call("switchAccount", name);
                    await page
                        .frameLocator(PRODUCT_FRAME)
                        .locator("body")
                        .waitFor({ state: "attached" });
                },
                setAccounts: async (names) => {
                    await call("setAccounts", names);
                    await page
                        .frameLocator(PRODUCT_FRAME)
                        .locator("body")
                        .waitFor({ state: "attached" });
                },
                signOut: () => call("signOut"),
                reset: () => call("reset"),
                // Sent as hex, not bytes: `page.evaluate` serialises a Uint8Array as a
                // plain index object, which would inject a statement of nothing.
                injectStatement: (statement) => page.evaluate((value) => {
                    const host = window.__TRUAPI_TEST_HOST__;
                    if (!host)
                        throw new Error("test host is not running on this page");
                    return host.injectStatement(value);
                }, typeof statement === "string" ? statement : `0x${Array.from(statement, (b) => b.toString(16).padStart(2, "0")).join("")}`),
                getInjectedStatements: () => call("getInjectedStatements"),
                clearStatements: () => call("clearStatements"),
                getSubmittedStatements: () => call("getSubmittedStatements"),
                // Playwright closes the page after the fixture yields, so there is
                // genuinely nothing to do -- not a silent stub standing in for work.
                dispose: () => Promise.resolve(),
                setPaymentBalance: () => {
                    throw new Error(`testHost.setPaymentBalance ${NO_PAYMENT_SEAM}`);
                },
                getPaymentLog: () => {
                    throw new Error(`testHost.getPaymentLog ${NO_PAYMENT_SEAM}`);
                },
                clearPaymentLog: () => {
                    throw new Error(`testHost.clearPaymentLog ${NO_PAYMENT_SEAM}`);
                },
                setPaymentTopUpBehavior: () => {
                    throw new Error(`testHost.setPaymentTopUpBehavior ${NO_PAYMENT_SEAM}`);
                },
                simulatePaymentStatus: () => {
                    throw new Error(`testHost.simulatePaymentStatus ${NO_PAYMENT_SEAM}`);
                },
                injectChatAction: (action) => page.evaluate((value) => {
                    const host = window.__TRUAPI_TEST_HOST__;
                    if (!host)
                        throw new Error("test host is not running on this page");
                    return host.injectChatAction(value);
                }, action),
                setLoginBehavior: () => {
                    throw new Error(`testHost.setLoginBehavior ${LOGIN_BEHAVIOR_IS_CONSTRUCTION_TIME}`);
                },
            };
            await use(testHost);
        },
    };
}
