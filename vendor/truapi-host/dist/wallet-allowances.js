/** Bound trusted shell hints before crossing the worker boundary. Native code
 * applies the canonical product-ID rules before deriving or querying accounts. */
export function validateAllowanceProductIds(value) {
    if (!Array.isArray(value) ||
        value.length > 32 ||
        new Set(value).size !== value.length) {
        throw new Error("allowance inspection requires at most 32 unique nonempty product IDs");
    }
    for (const id of value) {
        if (typeof id !== "string" || id.trim().length === 0) {
            throw new Error("allowance inspection requires nonempty product IDs");
        }
    }
    return [...value];
}
function requireValid(condition) {
    if (!condition)
        throw new Error("invalid wallet allowance snapshot");
}
function record(value) {
    requireValid(typeof value === "object" && value !== null && !Array.isArray(value));
    return value;
}
function text(value) {
    return typeof value === "string" && value.length > 0;
}
function uint(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function units(value) {
    return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}
function hash(value) {
    return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}
function array(value) {
    requireValid(Array.isArray(value));
    return value;
}
function claims(value) {
    requireValid(uint(value.period) && uint(value.resetsAt));
    const collections = new Set();
    for (const item of array(value.pools)) {
        const pool = record(item);
        requireValid((pool.collection === "People" || pool.collection === "LitePeople") &&
            !collections.has(pool.collection));
        collections.add(pool.collection);
        requireValid((pool.membership === "verified" || pool.membership === "not-found") &&
            typeof pool.selected === "boolean" &&
            uint(pool.limit) &&
            uint(pool.used) &&
            uint(pool.remaining) &&
            (pool.membership === "not-found"
                ? pool.remaining === 0 && pool.selected === false
                : pool.remaining === Math.max(0, pool.limit - pool.used)));
        const indices = new Set();
        for (const entry of array(pool.slots)) {
            const slot = record(entry);
            requireValid(uint(slot.index) &&
                !indices.has(slot.index) &&
                (slot.accountId === undefined || hash(slot.accountId)) &&
                (slot.productId === undefined || text(slot.productId)) &&
                (slot.label === undefined || text(slot.label)) &&
                (slot.since === undefined || uint(slot.since)));
            indices.add(slot.index);
        }
    }
}
function observation(value) {
    const item = record(value);
    requireValid(hash(item.genesisHash) &&
        hash(item.blockHash) &&
        uint(item.blockNumber) &&
        uint(item.specVersion) &&
        uint(item.chainTimestamp));
}
function section(value, validate) {
    const item = record(value);
    if (item.status === "unavailable") {
        requireValid(text(item.reason));
        return;
    }
    requireValid(item.status === "available");
    observation(item.observation);
    validate(record(item.value));
}
/** Validate once at the native JSON boundary, before treating an observation as
 * current wallet data. Malformed data is rejected, never converted to capacity. */
export function validateWalletAllowanceSnapshot(value, identityAccountId, networkSuffix, productIds) {
    const snapshot = record(value);
    requireValid(snapshot.schemaVersion === 1 &&
        hash(snapshot.identityAccountId) &&
        snapshot.identityAccountId === identityAccountId &&
        snapshot.networkSuffix === networkSuffix);
    const requested = new Set(productIds);
    const actual = validateAllowanceProductIds(snapshot.productIds);
    requireValid(actual.length === requested.size && actual.every((id) => requested.has(id)));
    const accounts = (value, validate) => {
        const seen = new Set();
        for (const entry of array(value)) {
            const account = record(entry);
            requireValid(text(account.productId) &&
                requested.has(account.productId) &&
                !seen.has(account.productId) &&
                hash(account.accountId));
            seen.add(account.productId);
            validate(account);
        }
        requireValid(seen.size === requested.size);
    };
    section(snapshot.statementStore, (value) => {
        claims(value);
        requireValid(uint(value.graceSeconds) && uint(value.replacementCooldownSeconds));
    });
    section(snapshot.pgasClaims, (value) => {
        claims(value);
        observation(value.membershipObservation);
        requireValid(text(value.assetId) && units(value.claimAmount));
    });
    section(snapshot.pgasBalances, (value) => {
        requireValid(text(value.assetId) &&
            (value.decimals === null || uint(value.decimals)) &&
            (value.symbol === null || text(value.symbol)));
        accounts(value.accounts, (account) => {
            requireValid(account.derivationIndex === 0 &&
                (units(account.balance) ||
                    (account.balance === null && text(account.error))) &&
                (account.error === undefined || text(account.error)));
        });
    });
    section(snapshot.bulletinClaims, claims);
    section(snapshot.bulletinQuotas, (value) => accounts(value.accounts, (account) => {
        requireValid(["active", "expired", "missing", "unavailable"].includes(String(account.status)));
        for (const key of ["bytesUsed", "bytesLimit", "bytesRemaining"]) {
            requireValid(account[key] === undefined || units(account[key]));
        }
        for (const key of [
            "transactionsUsed",
            "transactionsLimit",
            "transactionsRemaining",
            "expiresAtBlock",
        ]) {
            requireValid(account[key] === undefined || uint(account[key]));
        }
        requireValid(account.error === undefined || text(account.error));
        if (account.status === "unavailable")
            requireValid(text(account.error));
        if (account.status === "active" || account.status === "expired") {
            requireValid(units(account.bytesUsed) &&
                units(account.bytesLimit) &&
                units(account.bytesRemaining) &&
                uint(account.transactionsUsed) &&
                uint(account.transactionsLimit) &&
                uint(account.transactionsRemaining) &&
                uint(account.expiresAtBlock));
        }
    }));
}
