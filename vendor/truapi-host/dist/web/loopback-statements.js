// An in-page statement store, for suites that exercise a product's
// statement flows without a chain.
//
// The core reaches the statement store over its chain connection, so this is
// where a host can serve one: `statement_submit` is accepted and fanned out to
// the matching subscriptions, and nothing leaves the page. A statement
// accepted here is not registered anywhere, so a real store would refuse what
// this one takes.
import { scale, StatementProof } from "@parity/truapi";
/** Statement methods the core sends over the chain connection. */
const SUBMIT = "statement_submit";
const SUBSCRIBE = "statement_subscribeStatement";
const UNSUBSCRIBE = "statement_unsubscribeStatement";
function hex(bytes) {
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function bytes(value) {
    const body = value.startsWith("0x") ? value.slice(2) : value;
    return Uint8Array.from((body.match(/../g) ?? []).map((b) => parseInt(b, 16)));
}
/**
 * One field of a statement, as the statement store encodes it.
 *
 * The store takes a SCALE vector of tagged fields, not a struct: the protocol's
 * own `SignedStatement` is a different encoding of the same information and
 * decoding one as the other yields nothing. Topics are separate fields rather
 * than a list, which is why there can be at most four.
 *
 * Upstream: `substrate/primitives/statement-store/src/lib.rs`.
 */
const StatementField = scale.TaggedUnion({
    Proof: StatementProof,
    DecryptionKey: scale.Hex(32),
    Expiry: scale.u64,
    Channel: scale.Hex(32),
    Topic1: scale.Hex(32),
    Topic2: scale.Hex(32),
    Topic3: scale.Hex(32),
    Topic4: scale.Hex(32),
    Data: scale.Hex(),
});
/** A statement on the wire: the fields it carries, in encoding order. */
const StatementFields = scale.Vector(StatementField);
/** The field tags that carry a topic, in the order they encode. */
export const TOPIC_FIELD_TAGS = [
    "Topic1",
    "Topic2",
    "Topic3",
    "Topic4",
];
/** The same tags, typed for indexing when encoding. */
const TOPIC_TAGS = ["Topic1", "Topic2", "Topic3", "Topic4"];
/** Fields of a statement, or `undefined` when it will not decode. */
export function decodeStatement(encoded) {
    try {
        return StatementFields.dec(bytes(encoded));
    }
    catch {
        return undefined;
    }
}
/**
 * Topics of a submitted statement, or `undefined` when it will not decode.
 *
 * An undecodable statement is still delivered, to everything: a suite chasing
 * a missing delivery has something to see, where a silent drop looks like the
 * product never submitted.
 */
function topicsOf(encoded) {
    const fields = decodeStatement(encoded);
    if (!fields)
        return undefined;
    return fields
        .filter((field) => TOPIC_TAGS.includes(field.tag))
        .map((field) => String(field.value).toLowerCase());
}
/**
 * A zero Sr25519 proof, carried because the codec requires one.
 *
 * Nothing in the page verifies it, which is of a piece with the rest of this
 * store: a statement accepted here is registered nowhere, and a real store
 * would refuse it. A suite reading `proof` off an injected statement is seeing
 * this placeholder, not a signature over the payload.
 */
const UNVERIFIED_PROOF = {
    tag: "Sr25519",
    value: {
        signature: `0x${"00".repeat(64)}`,
        signer: `0x${"00".repeat(32)}`,
    },
};
/** Encode `input` the way a product's submission arrives. */
export function encodeStatement(input) {
    if (input.topics.length > TOPIC_TAGS.length) {
        // The store has four topic fields and no fifth, so a statement carrying
        // more cannot be encoded at all. Refused here rather than silently losing
        // the ones past the fourth, which a suite would read as a filter that
        // failed to match.
        throw new Error(`testHost injectStatement: a statement carries at most ` +
            `${TOPIC_TAGS.length} topics, and this one has ${input.topics.length}.`);
    }
    return hex(StatementFields.enc([
        { tag: "Proof", value: UNVERIFIED_PROOF },
        ...input.topics.map((topic, index) => ({
            tag: TOPIC_TAGS[index],
            value: topic,
        })),
        ...(input.data === undefined
            ? []
            : [{ tag: "Data", value: input.data }]),
    ]));
}
/** Read the filter the core sent, defaulting to "everything". */
function parseFilter(raw) {
    const toTopics = (values) => values.map((topic) => String(topic).toLowerCase());
    if (Array.isArray(raw))
        return { kind: "MatchAll", topics: toTopics(raw) };
    if (typeof raw !== "object" || raw === null) {
        return { kind: "MatchAll", topics: [] };
    }
    const filter = raw;
    for (const [key, kind] of [
        ["matchAny", "MatchAny"],
        ["matchAll", "MatchAll"],
    ]) {
        if (!(key in filter))
            continue;
        const topics = filter[key];
        return { kind, topics: Array.isArray(topics) ? toTopics(topics) : [] };
    }
    // An unreadable filter subscribes to everything: extra deliveries are
    // visible, a black hole is not.
    return { kind: "MatchAll", topics: [] };
}
/** Whether `topics` satisfies what this subscription asked for. */
function matches(subscription, topics) {
    if (subscription.topics.length === 0 || topics === undefined)
        return true;
    return subscription.kind === "MatchAll"
        ? subscription.topics.every((topic) => topics.includes(topic))
        : subscription.topics.some((topic) => topics.includes(topic));
}
/** Build the store. One per mock host, shared across its connections. */
export function createLoopbackStatements() {
    const subscriptions = new Set();
    const retained = [];
    let nextId = 1;
    const notify = (subscription, encoded) => {
        subscription.notify(JSON.stringify({
            jsonrpc: "2.0",
            method: SUBSCRIBE,
            params: {
                subscription: subscription.id,
                result: {
                    event: "newStatements",
                    data: { statements: [encoded], remaining: 0 },
                },
            },
        }));
    };
    const deliver = (encoded) => {
        const topics = topicsOf(encoded);
        let delivered = 0;
        for (const subscription of subscriptions) {
            if (!matches(subscription, topics))
                continue;
            notify(subscription, encoded);
            delivered += 1;
        }
        return delivered;
    };
    return {
        handle(request, respond) {
            let frame;
            try {
                frame = JSON.parse(request);
            }
            catch {
                return false;
            }
            const reply = (result) => respond(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
            switch (frame.method) {
                case SUBMIT: {
                    const encoded = String((frame.params ?? [])[0] ?? "");
                    retained.push({ encoded, fromProduct: true, timestamp: Date.now() });
                    // The core accepts only `new`/`known`, and reads `.status` off an
                    // object; a bare string is rejected as "not accepted".
                    reply({ status: "new" });
                    deliver(encoded);
                    return true;
                }
                case SUBSCRIBE: {
                    const id = `loopback-sub-${nextId++}`;
                    const subscription = {
                        id,
                        ...parseFilter((frame.params ?? [])[0]),
                        notify: respond,
                    };
                    subscriptions.add(subscription);
                    reply(id);
                    // Injections only: a store hands a new subscriber what someone else
                    // published, never that subscriber's own backlog. Replayed after the
                    // id is answered, because the core keys an incoming notification by
                    // the subscription it has not been told about yet and would drop
                    // what arrived first.
                    for (const statement of retained) {
                        if (statement.fromProduct)
                            continue;
                        if (matches(subscription, topicsOf(statement.encoded))) {
                            notify(subscription, statement.encoded);
                        }
                    }
                    return true;
                }
                case UNSUBSCRIBE: {
                    const target = String((frame.params ?? [])[0] ?? "");
                    for (const subscription of subscriptions) {
                        if (subscription.id === target)
                            subscriptions.delete(subscription);
                    }
                    reply(true);
                    return true;
                }
                default:
                    return false;
            }
        },
        release(respond) {
            for (const subscription of subscriptions) {
                if (subscription.notify === respond)
                    subscriptions.delete(subscription);
            }
        },
        statements: () => [...retained],
        // Narrowed by provenance rather than kept in a second list: `submitted()`
        // answers "did the product publish this", which an injection must not.
        submitted: () => retained.filter((statement) => statement.fromProduct),
        inject: (statement) => {
            const encoded = typeof statement === "string"
                ? statement.startsWith("0x")
                    ? statement
                    : `0x${statement}`
                : encodeStatement(statement);
            const entry = { encoded, fromProduct: false, timestamp: Date.now() };
            retained.push(entry);
            deliver(encoded);
            return entry;
        },
        clear: () => {
            retained.length = 0;
        },
    };
}
