import { type DevAccount, type DevAccountName } from "./dev-accounts.js";
/** Which account, product and index to derive. */
export interface ProductAccountQuery {
    /** The dev account whose session root the product account descends from. */
    account: DevAccountName | DevAccount;
    /** The product's dotNS identifier, e.g. `"tx-demo.dot"`. */
    productId: string;
    /** Index within the product's subtree. Defaults to `0`. */
    index?: number;
}
/**
 * The SS58 address of the product account `query` names.
 *
 * Encoded at the prefix the core mandates, which is not necessarily the one a
 * product displays. Pass it to a faucet or a transfer as it stands.
 *
 * Needs the built WASM bundle; see `wasmIsBuilt`.
 */
export declare function productAccountAddress(query: ProductAccountQuery): Promise<string>;
