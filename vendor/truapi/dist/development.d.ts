import type { HostAccountCreateProofRequest, HostAccountCreateProofResponse, TrUApiClient, VersionedHostAccountCreateProofError } from "./generated/index.js";
import type { ResultAsync } from "./generated/client.js";
import type { CallErrorValue, HexString } from "./scale.js";
/** Same as `HostAccountCreateProofRequest`, with the 32-byte context given raw. */
export interface DevelopmentCreateProofRequest extends Omit<HostAccountCreateProofRequest, "context"> {
    /** The exact 32 bytes the proof is bound to, as `0x`-prefixed hex. */
    context: HexString;
}
/**
 * `account.createAccountProof` with a verbatim 32-byte proof context instead of
 * a product-namespaced one.
 *
 */
export declare function development_createAccountProof(client: Pick<TrUApiClient, "account">, request: DevelopmentCreateProofRequest): ResultAsync<HostAccountCreateProofResponse, CallErrorValue<VersionedHostAccountCreateProofError>>;
