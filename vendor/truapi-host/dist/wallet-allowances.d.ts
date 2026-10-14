export type AllowanceCollection = "People" | "LitePeople";
export interface AllowanceObservation {
    genesisHash: string;
    blockHash: string;
    blockNumber: number;
    specVersion: number;
    /** Unix seconds from the pinned block. */
    chainTimestamp: number;
}
export type AllowanceSection<T> = {
    status: "available";
    observation: AllowanceObservation;
    value: T;
} | {
    status: "unavailable";
    reason: string;
};
export interface AllowanceSlot {
    index: number;
    accountId?: string;
    productId?: string;
    label?: string;
    since?: number;
}
export interface AllowancePool {
    collection: AllowanceCollection;
    membership: "verified" | "not-found";
    selected: boolean;
    limit: number;
    used: number;
    remaining: number;
    slots: AllowanceSlot[];
}
export interface AllowanceClaims {
    period: number;
    resetsAt: number;
    pools: AllowancePool[];
}
export interface StatementAllowanceSnapshot extends AllowanceClaims {
    graceSeconds: number;
    replacementCooldownSeconds: number;
}
export interface PgasClaimsSnapshot extends AllowanceClaims {
    /** Membership is observed on People, separately from Asset Hub claim storage. */
    membershipObservation: AllowanceObservation;
    assetId: string;
    /** Integer base units, never a floating-point amount. */
    claimAmount: string;
}
export interface PgasBalancesSnapshot {
    assetId: string;
    decimals: number | null;
    symbol: string | null;
    accounts: Array<{
        productId: string;
        accountId: string;
        derivationIndex: 0;
        /** Total balance, not a spendability promise. */
        balance: string | null;
        error?: string;
    }>;
}
export interface BulletinQuota {
    productId: string;
    accountId: string;
    status: "active" | "expired" | "missing" | "unavailable";
    bytesUsed?: string;
    bytesLimit?: string;
    bytesRemaining?: string;
    transactionsUsed?: number;
    transactionsLimit?: number;
    transactionsRemaining?: number;
    expiresAtBlock?: number;
    error?: string;
}
export interface WalletAllowanceSnapshot {
    schemaVersion: 1;
    identityAccountId: string;
    networkSuffix: string;
    productIds: string[];
    statementStore: AllowanceSection<StatementAllowanceSnapshot>;
    pgasClaims: AllowanceSection<PgasClaimsSnapshot>;
    pgasBalances: AllowanceSection<PgasBalancesSnapshot>;
    bulletinClaims: AllowanceSection<AllowanceClaims>;
    bulletinQuotas: AllowanceSection<{
        accounts: BulletinQuota[];
    }>;
}
/** Bound trusted shell hints before crossing the worker boundary. Native code
 * applies the canonical product-ID rules before deriving or querying accounts. */
export declare function validateAllowanceProductIds(value: unknown): string[];
/** Validate once at the native JSON boundary, before treating an observation as
 * current wallet data. Malformed data is rejected, never converted to capacity. */
export declare function validateWalletAllowanceSnapshot(value: unknown, identityAccountId: string, networkSuffix: string, productIds: readonly string[]): asserts value is WalletAllowanceSnapshot;
