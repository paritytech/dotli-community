import { scale, StatementProof } from "@parity/truapi";
/** A statement on the wire: the fields it carries, in encoding order. */
declare const StatementFields: scale.Codec<({
    tag: "Proof";
    value: StatementProof;
} | {
    tag: "DecryptionKey";
    value: `0x${string}`;
} | {
    tag: "Expiry";
    value: bigint;
} | {
    tag: "Channel";
    value: `0x${string}`;
} | {
    tag: "Topic1";
    value: `0x${string}`;
} | {
    tag: "Topic2";
    value: `0x${string}`;
} | {
    tag: "Topic3";
    value: `0x${string}`;
} | {
    tag: "Topic4";
    value: `0x${string}`;
} | {
    tag: "Data";
    value: `0x${string}`;
})[]>;
/** The field tags that carry a topic, in the order they encode. */
export declare const TOPIC_FIELD_TAGS: readonly string[];
/** Fields of a statement, or `undefined` when it will not decode. */
export declare function decodeStatement(encoded: string): ReturnType<typeof StatementFields.dec> | undefined;
/** One statement the store retained, and where it came from. */
export interface RetainedStatement {
    /** The statement as submitted, `0x` hex. */
    encoded: string;
    /** True when the product submitted it, false when a test injected it. */
    fromProduct: boolean;
    /** When the store took it, as epoch milliseconds. */
    timestamp: number;
}
/** A statement to inject, in the decoded shape a suite writes. */
export interface StatementInput {
    /** Up to four `0x`-hex topics; an empty list matches a bare subscription. */
    topics: string[];
    /** `0x`-hex payload. */
    data?: string;
}
/** Encode `input` the way a product's submission arrives. */
export declare function encodeStatement(input: StatementInput): string;
/** A statement store shared by every connection the host hands out. */
export interface LoopbackStatements {
    /** Handle one request, or return false to leave it to the caller. */
    handle(request: string, respond: (frame: string) => void): boolean;
    /** Forget the subscriptions one connection owns. */
    release(respond: (frame: string) => void): void;
    /** Every statement the store retained, in order. */
    statements(): RetainedStatement[];
    /** Statements the product submitted, in order. */
    submitted(): RetainedStatement[];
    /**
     * Retain `statement` and deliver it as if someone else had submitted it.
     *
     * Retained, not just delivered, so a subscription opened afterwards is
     * replayed it: a suite that injects before its product subscribes would
     * otherwise see nothing, with no way to tell that from a dropped delivery.
     */
    inject(statement: StatementInput | string): RetainedStatement;
    /**
     * Drop every retained statement.
     *
     * Live subscriptions stay open and keep receiving; one opened afterwards
     * starts from empty.
     */
    clear(): void;
}
/** Build the store. One per mock host, shared across its connections. */
export declare function createLoopbackStatements(): LoopbackStatements;
export {};
