/** `productId` the signing host reads as "use the suffix bytes verbatim". */
const RAW_PROOF_CONTEXT_PRODUCT_ID = "raw:";
/**
 * `account.createAccountProof` with a verbatim 32-byte proof context instead of
 * a product-namespaced one.
 *
 */
export function development_createAccountProof(client, request) {
    const { context, ...rest } = request;
    return client.account.createAccountProof({
        ...rest,
        context: rawProofContext(context),
    });
}
function rawProofContext(context) {
    const digits = context.startsWith("0x") ? context.slice(2) : null;
    if (digits === null ||
        digits.length !== 64 ||
        !/^[0-9a-fA-F]*$/.test(digits)) {
        throw new TypeError(`development_createAccountProof: context must be 32 bytes of 0x-prefixed hex, got ${JSON.stringify(context)}`);
    }
    return {
        productId: RAW_PROOF_CONTEXT_PRODUCT_ID,
        suffix: { tag: "Raw", value: context },
    };
}
