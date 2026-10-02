/** Name of a built-in dev account. */
export type DevAccountName = "alice" | "bob" | "charlie" | "dave";
/** A dev account: a name and the entropy its session is activated from. */
export interface DevAccount {
    /** The name a test refers to it by. */
    name: string;
    /** 32 bytes of BIP-39 entropy. */
    entropy: Uint8Array;
}
/**
 * The built-in dev accounts.
 *
 * Distinct markers rather than sequential values: a one-byte difference is easy
 * to miss when comparing two hex dumps in a failing test.
 */
export declare const DEV_ACCOUNTS: Record<DevAccountName, Uint8Array>;
/**
 * The built-in dev account names.
 *
 * Named as `@parity/host-api-test-sdk` names it, so a suite iterating the
 * roster reads the same export from either.
 */
export declare const DEV_ACCOUNT_NAMES: DevAccountName[];
/** Whether `name` is one of the built-in dev accounts. */
export declare function isDevAccountName(name: string): name is DevAccountName;
/**
 * Resolve an account spec to the entropy its session activates from.
 *
 * Accepts a built-in name or an explicit `{ name, entropy }`, so a suite that
 * needs a specific key is not forced to use one of the four.
 */
export declare function resolveAccount(spec: DevAccountName | DevAccount): DevAccount;
/**
 * Real public networks a suite can proxy to.
 *
 * Genesis hashes are the chains' own, not {@link MOCK_GENESIS} placeholders:
 * the core asks for a chain by hash, so proxying only works when the hash the
 * runtime config carries is the real one.
 *
 * Using these makes a run non-hermetic. It inherits whatever the public chain
 * is doing -- accumulated state from other runs, contracts that were reaped,
 * endpoint outages -- which is the cost of testing against real inclusion.
 */
export declare const LIVE_CHAINS: {
    /** Paseo Asset Hub. */
    readonly paseoAssetHub: {
        readonly rpcUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io";
        /**
         * Declare this in the host's runtime config when proxying to this chain.
         *
         * Not used for proxy routing -- an unhashed proxy takes every request, so
         * routing survives a reset. This value is needed because the *product*
         * checks it: `@parity/product-sdk-descriptors` refuses a host whose
         * declared genesis disagrees with the descriptor it was built against.
         *
         * It goes stale when the chain is reset, and it has more than once. When a
         * product reports a genesis mismatch, read the chain's current hash with
         * `chain_getBlockHash(0)` and re-pin it here.
         */
        readonly genesisHash: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a";
    };
};
/**
 * Paseo Asset Hub in `@parity/host-api-test-sdk`'s `NetworkConfig` shape.
 *
 * Named as `@parity/host-api-test-sdk` names it, so `networks: [PASEO_ASSET_HUB]`
 * means the same thing here. The genesis hash is the one the chain reports
 * today, NOT the
 * value that package ships -- its own constant went stale across a chain reset
 * and no longer matches this endpoint, so copying it would import a known-bad
 * value. Re-pin from `chain_getBlockHash(0)` after a reset.
 *
 * The other networks that package declares are deliberately not mirrored:
 * nothing here uses them and their genesis hashes have not been checked
 * against a live endpoint, so exporting them would ship unverified values.
 */
export declare const PASEO_ASSET_HUB: {
    readonly id: "paseo-asset-hub";
    readonly name: "Paseo Asset Hub";
    readonly genesisHash: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a";
    readonly rpcUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io";
    readonly tokenSymbol: "PAS";
    readonly tokenDecimals: 10;
};
/** The chain a suite gets when it names none. */
export declare const DEFAULT_CHAIN: {
    readonly id: "paseo-asset-hub";
    readonly name: "Paseo Asset Hub";
    readonly genesisHash: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a";
    readonly rpcUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io";
    readonly tokenSymbol: "PAS";
    readonly tokenDecimals: 10;
};
/**
 * Fixture settings for proxying one real chain.
 *
 * A live chain has to agree in three places -- what the host proxies to, what
 * it reports serving, and what its runtime config declares -- and the product
 * checks the last two against its own descriptor bundle. Getting one of them
 * wrong fails as a genesis mismatch that names neither the setting nor the
 * file, so this builds all three from one value.
 *
 * ```ts
 * createTestHostFixture({
 *   productUrl,
 *   hostUrl: server.url,
 *   ...liveChain(LIVE_CHAINS.paseoAssetHub),
 * });
 * ```
 */
export declare function liveChain(chain: {
    rpcUrl: string;
    genesisHash: string;
}): {
    mock: {
        chainProxies: {
            rpcUrl: string;
        }[];
        supportedChains: {
            network: string;
            chains: {
                identifier: "AssetHub";
                genesisHash: `0x${string}`;
            }[];
        };
    };
    runtimeConfig: Record<string, unknown>;
};
