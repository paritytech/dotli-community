/** A statement store shared by every connection the host hands out. */
export interface LoopbackStatements {
    /** Handle one request, or return false to leave it to the caller. */
    handle(request: string, respond: (frame: string) => void): boolean;
    /** Forget the subscriptions one connection owns. */
    release(respond: (frame: string) => void): void;
    /** Statements submitted so far, as `0x` hex, in order. */
    submitted(): string[];
    /** Deliver `statement` as if it had been submitted by someone else. */
    inject(statement: string): number;
    /** Drop the record of what was submitted. */
    clear(): void;
}
/** Build the store. One per mock host, shared across its connections. */
export declare function createLoopbackStatements(): LoopbackStatements;
