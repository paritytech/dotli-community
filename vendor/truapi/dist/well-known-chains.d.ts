/** Well-known chain descriptors. Each chain is its own `export const` so that
 * bundlers can tree-shake the ones a consumer does not import. */
import type { HexString } from "./scale.js";
export interface WellKnownChain {
    readonly name: string;
    readonly network: "Mainnet" | "Testnet";
    readonly genesis: HexString;
}
export declare const PASEO_NEXT_V2_ASSET_HUB: {
    readonly name: "Paseo Next v2 Hub";
    readonly network: "Testnet";
    readonly genesis: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a";
};
export declare const PASEO_NEXT_V2_INDIVIDUALITY: {
    readonly name: "Paseo Next v2 Individuality";
    readonly network: "Testnet";
    readonly genesis: "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48";
};
export declare const PREVIEWNET_ASSET_HUB: {
    readonly name: "Previewnet Hub";
    readonly network: "Testnet";
    readonly genesis: "0xc27c8bf3f13f96dc2130cd2b0a3debe57618fd02521ecc1902bd7dd4ed83d2fe";
};
export declare const PREVIEWNET_INDIVIDUALITY: {
    readonly name: "Previewnet Individuality";
    readonly network: "Testnet";
    readonly genesis: "0xf720c28fe3315e67fa799a616fc59abad47dd257b1a336af6538435844d35218";
};
