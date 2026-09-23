// A deterministic, in-memory mock host. `createMockHost` returns a complete
// `RequiredHostCallbacks` set (the JS sibling of `truapi-platform`'s
// `MockPlatform`) plus recordings for assertions. Hand `host.callbacks` to
// `createWebWorkerPairingHostRuntime` (or `createWasmRawCallbacks` directly) to
// run the real truapi-server WASM core against a mocked OS seam: storage is
// in-memory, permissions answer from a fixed policy, navigation/notifications
// are recorded, and the chain connection is silent (or replays canned frames).
//
// Signing and login park here because this mock backs a *pairing* host, which
// holds no key material of its own: both wait on a paired wallet answering
// over the statement-store channel, and the default silent chain never
// answers. The limit is the host role rather than the mock or the chain — a
// signing host's `sign_raw` completes against this same silent chain.
// Everything else (storage, permissions, features, theme, navigation,
// notifications, preimage lookup) works without a wallet.
//
// Preimage submission is core-owned on current core (the core builds, signs,
// and submits the Bulletin `TransactionStorage.store` transaction itself), so
// the mock only implements host-side content retrieval via `lookupPreimage`;
// seed retrievable content with the returned `insertPreimage`.
import { blake2b } from "@noble/hashes/blake2.js";
import { err, ok } from "neverthrow";
import { scale } from "@parity/truapi";
/**
 * A chain the host will proxy to, rather than answer from memory.
 *
 * Matched on `genesisHash`: the core asks for a chain by hash, so the hash here
 * must be the *real* one of the endpoint, not a {@link MOCK_GENESIS}
 * placeholder, and the runtime config must carry the same value.
 */
import { createLoopbackStatements } from "./loopback-statements.js";
/** A subscription that reports an injected fault instead of opening. */
async function* failedSubscription(reason) {
    yield err({ reason });
}
/**
 * An open subscription seeded with `first`, live from the moment it is created.
 *
 * `register` is called here rather than from inside the generator, whose body
 * does not run until its first `next()`. A change landing before that would
 * reach no subscriber and is never re-sent, so the consumer would park on a
 * value that is already stale. The Rust `MockPlatform` registers its sender
 * synchronously for the same reason.
 */
function liveSubscription(first, closers, register) {
    const pending = [first];
    let wake;
    let released = false;
    const unregister = register((item) => {
        pending.push(item);
        wake?.();
        wake = undefined;
    });
    // Idempotent because the two paths below overlap: closing a stream that has
    // been iterated runs the generator's `finally` as well as `return`.
    //
    // Waking is what lets a parked body finish. Unregistering alone would leave
    // it waiting on a push that can no longer arrive, so a `return()` queued
    // behind it, and the `next()` it is parked on, would both hang.
    const release = () => {
        if (released)
            return;
        released = true;
        closers.delete(release);
        unregister();
        wake?.();
        wake = undefined;
    };
    closers.add(release);
    const stream = (async function* () {
        try {
            for (;;) {
                while (pending.length > 0)
                    yield ok(pending.shift());
                if (released)
                    return;
                await new Promise((resolve) => {
                    wake = resolve;
                });
                if (released)
                    return;
            }
        }
        finally {
            release();
        }
    })();
    // `return`/`throw` release directly rather than relying on that `finally`.
    // A generator whose body has never run has nothing to unwind, so closing a
    // subscription created but not yet iterated would otherwise leave it
    // registered and pushing into a queue no one reads.
    const close = stream.return.bind(stream);
    const fail = stream.throw.bind(stream);
    stream.return = (value) => {
        release();
        return close(value);
    };
    stream.throw = (error) => {
        release();
        return fail(error);
    };
    return stream;
}
/**
 * A domain TrUAPI declares but no host implements.
 *
 * Reaching one throws a descriptive error rather than failing later with
 * `undefined is not a function`, and never fakes a success for a path the real
 * host cannot execute.
 */
const NOT_MODELLED_REASONS = {
    payment: "the protocol declares payments but no host implements them; " +
        "see docs/rfcs/0006-payments.md",
    coinPayment: "the protocol declares coin payments but no host implements them; " +
        "see docs/rfcs/0006-payments.md",
    statements: "the core owns the statement store and submits it over the people chain, " +
        "so there is no host seam for the mock to record or inject through",
};
function notModeled(domain) {
    return new Proxy({}, {
        get(_target, property) {
            const reason = NOT_MODELLED_REASONS[domain] ?? "no host implements this domain";
            throw new Error(`${domain}.${String(property)} is not available in the TrUAPI mock ` +
                `host: ${reason}.`);
        },
    });
}
/** Lowercase hex without `0x`, so a hash compares equal however it was written. */
function normalizeHash(hash) {
    if (typeof hash !== "string") {
        return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    return hash.replace(/^0x/i, "").toLowerCase();
}
/**
 * Open a real WebSocket to a chain and adapt it to `JsonRpcConnection`.
 *
 * Requests are still recorded in `sentRpc`, so a test can assert what the core
 * asked for even when a real node answers it.
 *
 * One socket per lease, never shared. Production opens a fresh connection for
 * every chain connect -- `truapi-provider`'s `connect` and the CLI's
 * `WsJsonRpcConnection::connect` both do -- and JSON-RPC ids are numbered per
 * connection from 1. Two leases on one socket therefore put two id spaces on
 * the same wire, and every inbound frame reaches every reader, so a lease sees
 * traffic it never asked for. That is transport behaviour no real host has and
 * the core can observe it, which makes sharing a fidelity bug rather than an
 * optimisation. Do not reintroduce it to save connections.
 *
 * This is not a multi-chain concern. Two leases on one chain are enough: they
 * would cross-talk, and releasing one would leave its listeners on a socket the
 * other still holds. A single-chain suite is not safe from it.
 */
function connectToChain(proxy, sentRpc, statementSubscriptions, loopback, 
// Injectors are held beside the connection rather than on it: the connection
// type is generated from the protocol and must not grow test-only members.
injectors, disconnectors) {
    const socket = new WebSocket(proxy.rpcUrl);
    const queued = [];
    const waiting = [];
    let closed = false;
    // Ids of `statement_subscribeStatement` requests, so the chain's reply to one
    // can be recognised and its subscription id recorded. Injection needs that
    // id: a notification carrying any other one is dropped by the core.
    const pendingStatementRequests = new Set();
    const open = new Promise((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error(`chain proxy failed to connect to ${proxy.rpcUrl}`)), { once: true });
    });
    const deliver = (text) => {
        const next = waiting.shift();
        if (next)
            next({ value: text, done: false });
        else
            queued.push(text);
    };
    socket.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : "";
        if (!text)
            return;
        if (statementSubscriptions)
            recordStatementSubscription(text);
        deliver(text);
    });
    /** Record the subscription id the chain assigned to a statement subscribe. */
    const ownStatementSubscriptions = new Set();
    const recordStatementSubscription = (text) => {
        try {
            const frame = JSON.parse(text);
            if (typeof frame.id === "string" &&
                pendingStatementRequests.delete(frame.id) &&
                typeof frame.result === "string") {
                statementSubscriptions?.add(frame.result);
                ownStatementSubscriptions.add(frame.result);
            }
        }
        catch {
            // A frame that is not JSON is not a subscribe reply; the core still gets
            // it, because parsing here must never drop chain traffic.
        }
    };
    const inject = (frame) => {
        if (!closed)
            deliver(frame);
    };
    injectors?.add(inject);
    const finish = () => {
        closed = true;
        injectors?.delete(inject);
        disconnectors?.delete(finish);
        // A closed connection's subscriptions are gone with it, and leaving the
        // ids behind makes `injectStatement` report deliveries to nobody.
        for (const id of ownStatementSubscriptions)
            statementSubscriptions?.delete(id);
        ownStatementSubscriptions.clear();
        loopback?.release(deliver);
        // Release every reader, so a stream ends instead of hanging on a drop.
        while (waiting.length > 0)
            waiting.shift()?.({ value: undefined, done: true });
    };
    disconnectors?.add(finish);
    socket.addEventListener("close", finish, { once: true });
    return {
        send(request) {
            sentRpc.push(request);
            // Served here rather than forwarded, so the statement flows work with no
            // chain behind them. Everything else still goes out.
            if (loopback?.handle(request, deliver))
                return;
            if (statementSubscriptions) {
                try {
                    const frame = JSON.parse(request);
                    if (frame.method === "statement_subscribeStatement" &&
                        typeof frame.id === "string") {
                        pendingStatementRequests.add(frame.id);
                    }
                }
                catch {
                    // Not JSON: nothing to track, and the send still goes out.
                }
            }
            // Sends before the socket is up are queued by the promise, not dropped.
            void open.then(() => {
                if (!closed)
                    socket.send(request);
            });
        },
        responses() {
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next() {
                            const buffered = queued.shift();
                            if (buffered !== undefined) {
                                return Promise.resolve({ value: buffered, done: false });
                            }
                            if (closed)
                                return Promise.resolve({ value: undefined, done: true });
                            return new Promise((resolve) => waiting.push(resolve));
                        },
                    };
                },
            };
        },
        close() {
            // The socket belongs to this lease alone, so ending the lease ends it.
            // Leaving it open would leak the connection and this lease's listeners.
            finish();
            socket.close();
        },
    };
}
/**
 * Content address of a preimage value: blake2b-256 of the raw bytes.
 *
 * This is the key the core derives before it asks the host to look a preimage
 * up, and it discards any value whose hash does not match the key it asked
 * for. A key computed any other way is unreachable through the core, however
 * well it round-trips against the mock alone.
 */
function preimageKey(value) {
    return blake2b(value, { dkLen: 32 });
}
function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
/**
 * Build an in-memory mock host. The returned `callbacks` implement every
 * `RequiredHostCallbacks` capability; the accessor methods expose what the core
 * did.
 */
export function createMockHost(config = {}) {
    const { devicePermissions: devicePermissionsInitial = "allow-all", remotePermissions: remotePermissionsInitial = "allow-all", featureSupported = true, theme = "Dark", confirmUserActions = true, chainResponses = [], chainClosed = false, chainProxies = [], languageTag = "en", faults = {}, supportedChains = {
        network: "mock",
        chains: [
            { identifier: "People", genesisHash: MOCK_GENESIS.people },
            { identifier: "Bulletin", genesisHash: MOCK_GENESIS.bulletin },
            { identifier: "AssetHub", genesisHash: MOCK_GENESIS.assetHub },
        ],
    }, } = config;
    const storage = new Map();
    const preimages = new Map();
    const navigations = [];
    const pushedNotifications = [];
    // Subscription ids the chain assigned to statement subscribes, and the live
    // chain connections a synthesized notification can be delivered through.
    const statementSubscriptions = new Set();
    const chainInjectors = new Set();
    const chainDisconnectors = new Set();
    const injectedStatements = [];
    const loopbackStatements = createLoopbackStatements();
    const usingLoopback = (chainProxies ?? []).some((proxy) => proxy.loopbackStatements);
    const sentRpc = [];
    const authStates = [];
    const reviews = [];
    const cancelledNotifications = [];
    const permissionLog = [];
    const openOperations = [];
    let nextOperationId = 0;
    const permissionDecisions = new Map();
    const chatRooms = new Map();
    const chatBots = new Map();
    const chatMessages = [];
    // Ids start at 1, not 0: the id is what the product cancels by, and a
    // product that treats 0 as "no id" cannot cancel the first notification it
    // ever schedules.
    let nextNotificationId = 1;
    let nextChatMessageId = 0;
    let devicePermissions = devicePermissionsInitial;
    let remotePermissions = remotePermissionsInitial;
    let enforcePermissions = false;
    let currentTheme = theme;
    // Live theme subscriptions, so `setTheme` reaches a subscribed product the way
    // the Rust mock's `theme_subscribers` does. A generator that ended after the
    // first value would make every `setTheme` in a migrating suite a no-op.
    /** Ends one live subscription each, so `dispose` can close them all. */
    const subscriptionClosers = new Set();
    const themeSubscribers = new Set();
    const chatRoomSubscribers = new Set();
    /**
     * Entries in key order, which is the order the Rust mock's `BTreeMap`
     * yields. Insertion order would put a different list in the subscription
     * payload than the sibling host sends for the same rooms.
     */
    const byKey = (entries) => [...entries.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, value]) => value);
    const publishChatRooms = () => {
        const item = { rooms: byKey(chatRooms) };
        for (const push of chatRoomSubscribers)
            push(item);
    };
    let chainStatus = "Idle";
    /**
     * One socket per proxied endpoint.
     *
     * A chainHead handshake is expensive, and the core opens a connection per
     * product. Pooling by URL means the second one costs nothing.
     */
    /**
     * Answer one permission prompt and record it.
     *
     * The key is the request's tag -- `"Camera"`, `"ChainSubmit"`. This scheme is
     * internal to the JS mock and deliberately independent of the Rust
     * `MockPlatform`'s `Display` keys: no state crosses that boundary, and only
     * the method names have to agree.
     */
    const decidePermission = (kind, tag, value, policy) => {
        const explicit = permissionDecisions.get(tag);
        const approved = explicit !== undefined
            ? explicit
            : enforcePermissions
                ? false
                : granted(policy);
        permissionLog.push({ tag, value, approved, kind });
        return approved;
    };
    // Product keys are namespaced from core slots so neither can shadow the other.
    // This in-JS key scheme is internal and independent from the Rust MockPlatform's
    // (state never crosses the boundary), so the two need not match byte-for-byte.
    // What they do have to share is which slots are distinct: keying on the tag
    // alone would put every product's manifest in one slot, so a test writing one
    // product's and reading another's reads back the wrong one here and a miss on
    // Rust.
    const productKey = (key) => `product:${key}`;
    const coreKey = (key) => key.value === undefined
        ? `core:${key.tag}`
        : // Entries sorted, so a payload built field-by-field in a different
            // order still addresses the slot it addressed before.
            `core:${key.tag}:${JSON.stringify(key.value, (_, inner) => inner !== null && typeof inner === "object" && !Array.isArray(inner)
                ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left.localeCompare(right)))
                : inner)}`;
    const granted = (policy) => policy === "allow-all";
    // A mock policy is two-valued, so a grant is durable and a refusal is
    // durable. `AllowOnce` is a host answer the mock has no knob to ask for.
    const decision = (approved) => approved ? "AllowAlways" : "Deny";
    // Per key, not one broadcast: a subscriber woken by every write would make a
    // test asserting "no change" pass for the wrong reason.
    const storageSubscribers = new Map();
    const publishStorage = (key, value) => {
        const item = { value: value && scale.bytesToHex(value) };
        for (const push of storageSubscribers.get(key) ?? [])
            push(item);
    };
    let hostCallCount = 0;
    /**
     * Wrap every callback in a namespace so each core->host call is counted.
     *
     * A test needs to know the wire is live before asserting on anything, and
     * the only honest evidence of that is the core actually having called the
     * host. Counting is cheap and needs no per-capability bookkeeping.
     */
    const countCallsIn = (namespace) => {
        for (const [name, value] of Object.entries(namespace)) {
            if (typeof value !== "function")
                continue;
            const original = value;
            namespace[name] = (...args) => {
                hostCallCount += 1;
                return original.apply(namespace, args);
            };
        }
    };
    // `RequiredHostCallbacks` (each capability wrapped in `Required<…>`): every
    // optional callback must be present, so a capability added to the generated
    // surface fails `tsc` here until the mock covers it. This is the load-bearing
    // coverage guarantee. `createWasmRawCallbacks` accepts this nested shape.
    const callbacks = {
        productStorage: {
            async read(key) {
                if (faults.storageError)
                    throw new Error(faults.storageError);
                return storage.get(productKey(key));
            },
            async write(key, value) {
                if (faults.storageError)
                    throw new Error(faults.storageError);
                storage.set(productKey(key), value);
                publishStorage(key, value);
            },
            async clear(key) {
                if (faults.storageError)
                    throw new Error(faults.storageError);
                storage.delete(productKey(key));
                publishStorage(key, undefined);
            },
            subscribeStorage(key) {
                const current = storage.get(productKey(key));
                return liveSubscription({ value: current && scale.bytesToHex(current) }, subscriptionClosers, (push) => {
                    const subscribers = storageSubscribers.get(key) ??
                        new Set();
                    storageSubscribers.set(key, subscribers);
                    subscribers.add(push);
                    return () => {
                        subscribers.delete(push);
                        if (subscribers.size === 0)
                            storageSubscribers.delete(key);
                    };
                });
            },
        },
        productOperations: {
            async beginOperation(product, label) {
                const id = nextOperationId++;
                openOperations.push({ productId: product.productId, id, label });
                return { id };
            },
            async endOperation(product, id) {
                // Idempotent by contract, so an unknown or already-ended id is fine.
                // Per product too: another product holding the same id must not drop
                // this one's demand.
                const at = openOperations.findIndex((open) => open.id === id && open.productId === product.productId);
                if (at !== -1)
                    openOperations.splice(at, 1);
            },
        },
        coreStorage: {
            async readCoreStorage(key) {
                if (faults.storageError)
                    throw new Error(faults.storageError);
                return storage.get(coreKey(key));
            },
            async writeCoreStorage(key, value) {
                if (faults.storageError)
                    throw new Error(faults.storageError);
                storage.set(coreKey(key), value);
            },
            async clearCoreStorage(key) {
                if (faults.storageError)
                    throw new Error(faults.storageError);
                storage.delete(coreKey(key));
            },
        },
        navigation: {
            async navigateTo(url) {
                if (faults.navigateError)
                    throw new Error(faults.navigateError);
                navigations.push(url);
            },
        },
        notifications: {
            async pushNotification(notification) {
                if (faults.notificationError)
                    throw new Error(faults.notificationError);
                const id = nextNotificationId++;
                pushedNotifications.push({
                    id,
                    text: notification.text,
                    deeplink: notification.deeplink,
                    scheduledAt: notification.scheduledAt,
                    cancelled: false,
                    timestamp: Date.now(),
                });
                return { id };
            },
            async cancelNotification(id) {
                cancelledNotifications.push(id);
                const entry = pushedNotifications.find((n) => n.id === id);
                if (entry)
                    entry.cancelled = true;
            },
        },
        permissions: {
            async devicePermission(_product, request) {
                if (faults.permissionError)
                    throw new Error(faults.permissionError);
                return decision(decidePermission("device", request, request, devicePermissions));
            },
            async remotePermission(_product, request) {
                if (faults.permissionError)
                    throw new Error(faults.permissionError);
                return decision(decidePermission("remote", request.permission.tag, request.permission, remotePermissions));
            },
        },
        features: {
            async featureSupported() {
                if (faults.featureError)
                    throw new Error(faults.featureError);
                return { supported: featureSupported };
            },
            async supportedChains() {
                if (faults.featureError)
                    throw new Error(faults.featureError);
                return supportedChains;
            },
        },
        chain: {
            async connect(genesisHash) {
                // A simulated disconnect blocks reconnect until `simulateReconnect`,
                // the way the Rust mock does, so a suite testing recovery sees the
                // failure it is testing for rather than a connection that succeeds.
                if (chainStatus === "Disconnected") {
                    throw new Error("mock chain is disconnected");
                }
                // A hashed entry wins; an unhashed one takes whatever is left.
                const proxy = chainProxies.find((candidate) => candidate.genesisHash !== undefined &&
                    normalizeHash(candidate.genesisHash) === normalizeHash(genesisHash)) ?? chainProxies.find((candidate) => candidate.genesisHash === undefined);
                if (proxy) {
                    // After the dial, not before: a proxy that fails to open must leave
                    // the status alone rather than report a connection that is not there.
                    const connection = connectToChain(proxy, sentRpc, statementSubscriptions, proxy.loopbackStatements ? loopbackStatements : undefined, chainInjectors, chainDisconnectors);
                    chainStatus = "Connected";
                    return connection;
                }
                chainStatus = "Connected";
                // A proxied connection registers its disconnector inside
                // `connectToChain`; this one is held by nothing else, so it registers
                // its own. Without it `simulateDisconnect` would leave the stream below
                // parked and only the reported status would change.
                let dropped;
                const transportDropped = new Promise((resolve) => {
                    dropped = resolve;
                });
                const disconnect = () => dropped?.();
                chainDisconnectors.add(disconnect);
                return {
                    send(request) {
                        sentRpc.push(request);
                    },
                    async *responses() {
                        try {
                            for (const frame of chainResponses) {
                                yield frame;
                            }
                            if (chainResponses.length === 0 && !chainClosed) {
                                // Silent: yields nothing, so chain-dependent flows park until
                                // the transport drops. `chainClosed` instead ends the stream
                                // here for fail-fast disconnect tests.
                                await transportDropped;
                            }
                        }
                        finally {
                            chainDisconnectors.delete(disconnect);
                        }
                    },
                    // The mock holds no real transport, so releasing the lease is a no-op.
                    // Note: a Silent connection whose `responses()` stream is already parked
                    // stays parked after close() — tests that need the stream to terminate use
                    // `simulateDisconnect`, `chainClosed`, or scripted frames, not close().
                    close() { },
                };
            },
        },
        auth: {
            authStateChanged(state) {
                authStates.push(state);
            },
        },
        userConfirmation: {
            async confirmUserAction(review) {
                reviews.push(review);
                if (faults.confirmationError)
                    throw new Error(faults.confirmationError);
                return confirmUserActions;
            },
            // The Rust trait answers this from `confirm_user_action` by default, so
            // a review is recorded here too and one knob still answers both.
            async confirmPermission(review) {
                reviews.push(review);
                if (faults.confirmationError)
                    throw new Error(faults.confirmationError);
                return decision(confirmUserActions);
            },
        },
        theme: {
            subscribeTheme() {
                return liveSubscription({ name: { tag: "Default" }, variant: currentTheme }, subscriptionClosers, (push) => {
                    themeSubscribers.add(push);
                    return () => themeSubscribers.delete(push);
                });
            },
        },
        chat: {
            async createChatRoom(_product, request) {
                if (faults.chatError)
                    throw new Error(faults.chatError);
                if (chatRooms.has(request.roomId))
                    return { status: "Exists" };
                chatRooms.set(request.roomId, {
                    roomId: request.roomId,
                    // A product that creates a room hosts it; a product reaching a room
                    // as a bot registers the bot instead.
                    participatingAs: "RoomHost",
                });
                publishChatRooms();
                return { status: "New" };
            },
            async registerChatBot(_product, request) {
                if (faults.chatError)
                    throw new Error(faults.chatError);
                if (chatBots.has(request.botId))
                    return { status: "Exists" };
                chatBots.set(request.botId, request);
                return { status: "New" };
            },
            async postChatMessage(_product, request) {
                if (faults.chatError)
                    throw new Error(faults.chatError);
                // Posting to a room the product never registered is a product bug,
                // and a mock that silently accepted it would hide one.
                if (!chatRooms.has(request.roomId)) {
                    throw new Error(`unknown chat room ${request.roomId}`);
                }
                const messageId = `mock-message:${nextChatMessageId++}`;
                chatMessages.push({
                    messageId,
                    roomId: request.roomId,
                    payload: request.payload,
                });
                return { messageId };
            },
            subscribeChatRooms() {
                // The other chat calls fail with this reason, so the subscription
                // reports it too rather than handing back a stream that looks healthy
                // and never carries the rooms a failing host would refuse to list.
                if (faults.chatError) {
                    return failedSubscription(faults.chatError);
                }
                return liveSubscription({ rooms: byKey(chatRooms) }, subscriptionClosers, (push) => {
                    chatRoomSubscribers.add(push);
                    return () => chatRoomSubscribers.delete(push);
                });
            },
        },
        locale: {
            async *subscribeLocale() {
                yield ok({ languageTag });
                // A live subscription never ends, matching `subscribeTheme`.
                await new Promise(() => { });
            },
        },
        preimage: {
            async *lookupPreimage(key) {
                yield ok(preimages.get(hex(key)));
                // Stay open for future updates (none, in the mock).
                await new Promise(() => { });
            },
        },
    };
    // Wrapped in place so the declared `RequiredHostCallbacks` type is preserved
    // rather than cast back on.
    for (const namespace of Object.values(callbacks)) {
        countCallsIn(namespace);
    }
    return {
        callbacks,
        getNavigationLog: () => [...navigations],
        getNotificationLog: () => pushedNotifications.map((n) => ({ ...n })),
        injectStatement: (statement) => {
            if (usingLoopback) {
                const encoded = typeof statement === "string"
                    ? statement.startsWith("0x")
                        ? statement
                        : `0x${statement}`
                    : `0x${hex(statement)}`;
                injectedStatements.push(encoded);
                return loopbackStatements.inject(encoded);
            }
            const encoded = typeof statement === "string"
                ? statement.startsWith("0x")
                    ? statement
                    : `0x${statement}`
                : `0x${hex(statement)}`;
            injectedStatements.push(encoded);
            let delivered = 0;
            for (const subscription of statementSubscriptions) {
                // The envelope the chain sends, not the bare statement: the core reads
                // `result.data.statements`, so a bare value decodes to nothing.
                const frame = JSON.stringify({
                    jsonrpc: "2.0",
                    method: "statement_subscribeStatement",
                    params: {
                        subscription,
                        result: {
                            event: "newStatements",
                            data: { statements: [encoded], remaining: 0 },
                        },
                    },
                });
                for (const injector of chainInjectors)
                    injector(frame);
                delivered += 1;
            }
            return delivered;
        },
        getInjectedStatements: () => [...injectedStatements],
        getSubmittedStatements: () => usingLoopback
            ? loopbackStatements.submitted()
            : sentRpc.flatMap((request) => {
                try {
                    const frame = JSON.parse(request);
                    if (frame.method !== "statement_submit")
                        return [];
                    const [statement] = frame.params ?? [];
                    return typeof statement === "string" ? [statement] : [];
                }
                catch {
                    // A frame that is not JSON is not a submission.
                    return [];
                }
            }),
        clearStatements: () => {
            injectedStatements.length = 0;
            loopbackStatements.clear();
        },
        sentRpc: () => [...sentRpc],
        authStates: () => [...authStates],
        reviews: () => [...reviews],
        confirmations: () => reviews.map((review) => review.tag),
        getSigningLog: () => reviews.flatMap((review) => {
            const type = review.tag === "SignRaw"
                ? "raw"
                : review.tag === "SignPayload"
                    ? "payload"
                    : review.tag === "CreateTransaction"
                        ? "createTransaction"
                        : undefined;
            return type === undefined
                ? []
                : [{ type, payload: review.value }];
        }),
        getHostCallCount: () => hostCallCount,
        getIsAuthenticated: () => authStates.at(-1)?.tag === "Connected",
        getConnectionStatus: () => chainStatus,
        setPermissionBehavior: (behavior) => {
            devicePermissions = behavior;
            remotePermissions = behavior;
        },
        dispose() {
            this.reset();
            // Ending each stream rather than just dropping its registration: a
            // consumer parked on `next()` has to learn the host is gone, and a
            // registration dropped underneath it would leave it waiting forever.
            for (const close of [...subscriptionClosers])
                close();
            for (const disconnect of [...chainDisconnectors])
                disconnect();
        },
        cancelledNotifications: () => [...cancelledNotifications],
        getPermissionLog: () => [...permissionLog],
        getGrantedPermissions: () => [...permissionDecisions.entries()]
            .filter(([, isGranted]) => isGranted)
            .map(([permission]) => permission)
            .sort(),
        grantPermission: (permission) => {
            permissionDecisions.set(permission, true);
        },
        revokePermission: (permission) => {
            permissionDecisions.set(permission, false);
        },
        resetPermission: (permission) => {
            permissionDecisions.delete(permission);
        },
        setEnforcePermissions: (enforce) => {
            enforcePermissions = enforce;
        },
        getTheme: () => currentTheme,
        setTheme: (variant) => {
            currentTheme = variant;
            const item = {
                name: { tag: "Default" },
                variant,
            };
            for (const push of themeSubscribers)
                push(item);
        },
        getChainStatus: () => chainStatus,
        simulateDisconnect: () => {
            chainStatus = "Disconnected";
            // Ending each live stream is what makes this a dropped transport rather
            // than a relabelled one: a product waiting on responses learns, and the
            // Rust mock does the same by dropping its disconnectors.
            for (const disconnect of [...chainDisconnectors])
                disconnect();
        },
        simulateReconnect: () => {
            chainStatus = "Idle";
        },
        getOpenOperations: () => [...openOperations],
        getChatRooms: () => byKey(chatRooms),
        getChatBots: () => byKey(chatBots),
        getChatMessageLog: () => [...chatMessages],
        seedPreimage(value) {
            const key = preimageKey(value);
            preimages.set(hex(key), value);
            return key;
        },
        getProductStorage: () => {
            const prefix = productKey("");
            const entries = {};
            for (const [key, value] of storage) {
                if (key.startsWith(prefix))
                    entries[key.slice(prefix.length)] = value;
            }
            return entries;
        },
        getPreimages: () => [...preimages.values()],
        clearNavigationLog: () => {
            navigations.length = 0;
        },
        clearNotificationLog: () => {
            pushedNotifications.length = 0;
            cancelledNotifications.length = 0;
        },
        clearSigningLog: () => {
            reviews.length = 0;
        },
        clearPermissionLog: () => {
            permissionLog.length = 0;
        },
        clearPermissionDecisions: () => permissionDecisions.clear(),
        clearAuthStates: () => {
            authStates.length = 0;
        },
        clearSentRpc: () => {
            sentRpc.length = 0;
        },
        clearPreimages: () => preimages.clear(),
        clearStorage: () => storage.clear(),
        clearChatState: () => {
            chatRooms.clear();
            chatBots.clear();
            chatMessages.length = 0;
            // Live subscriptions stay open and see the emptied list, as on Rust.
            publishChatRooms();
        },
        reset() {
            this.clearNavigationLog();
            this.clearNotificationLog();
            this.clearSigningLog();
            this.clearPermissionLog();
            this.clearPermissionDecisions();
            this.clearAuthStates();
            this.clearSentRpc();
            this.clearPreimages();
            this.clearStorage();
            this.clearChatState();
            this.clearStatements();
            openOperations.length = 0;
            nextOperationId = 0;
            // Through the setter, so a subscribed product is told rather than left
            // believing the theme it last saw while `getTheme` reports the default.
            this.setTheme(theme);
            // The policies a `setPermissionBehavior` call replaced: leaving them in
            // place lets one case govern the next, which is what reset is for.
            devicePermissions = devicePermissionsInitial;
            remotePermissions = remotePermissionsInitial;
            chainStatus = "Idle";
            enforcePermissions = false;
            nextNotificationId = 1;
            nextChatMessageId = 0;
            hostCallCount = 0;
        },
        statements: notModeled("statements"),
        payment: notModeled("payment"),
        coinPayment: notModeled("coinPayment"),
    };
}
/**
 * Genesis hashes the mock host serves, one distinct non-zero value per chain.
 *
 * Distinct matters: chain routing is keyed on the genesis hash, so equal
 * hashes make the chains indistinguishable and a chain-routed call resolves to
 * whichever entry is found first. Non-zero matters for the same reason -- an
 * all-zero hash is also the natural placeholder a caller passes by accident.
 */
export const MOCK_GENESIS = {
    people: "0x1111111111111111111111111111111111111111111111111111111111111111",
    bulletin: "0x2222222222222222222222222222222222222222222222222222222222222222",
    assetHub: "0x3333333333333333333333333333333333333333333333333333333333333333",
};
/**
 * A default {@link ProductRuntimeConfig} for a mock host. Override any field;
 * the genesis hashes and product id are placeholders suitable for tests.
 */
export function mockRuntimeConfig(overrides = {}) {
    return {
        productId: "mock.dot",
        host: {
            name: "Mock Host",
            icon: "https://example.invalid/mock.png",
            version: "0.0.0",
        },
        platform: {
            type: "node",
            version: "0",
        },
        people: { genesisHash: MOCK_GENESIS.people },
        bulletin: { genesisHash: MOCK_GENESIS.bulletin },
        assetHub: { genesisHash: MOCK_GENESIS.assetHub },
        pairing: {
            deeplinkScheme: "polkadotapp",
        },
        // A signing host refuses to start without this; a pairing host ignores it.
        // Setting it unconditionally keeps one config usable for both roles.
        networkSuffix: "paseo",
        ...overrides,
    };
}
