// The address a product account will be given, worked out without a host.
//
// A product account is derived from (session root, product id), so it exists
// before any host runs and is the same on every run. That is what lets a suite
// fund it once, in a `globalSetup`, rather than per test: funding is a property
// of the account, not of the run.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DerivationIndex } from "@parity/truapi";
import { checkDerivationIndex, resolveAccount, } from "./dev-accounts.js";
import { wasmArtifact } from "./require-wasm.js";
let loaded;
/** Load the core's wasm once, for the derivation helpers alone. */
async function derivation() {
    loaded ??= (async () => {
        const glue = (await import(
        // A file URL rather than a path: node refuses a Windows drive letter as
        // an ESM specifier.
        /* @vite-ignore */ pathToFileURL(wasmArtifact("testing/truapi_server.js")).href));
        // The bytes are handed over rather than left to the glue's own loader,
        // which fetches a URL: node has none to fetch, and a suite reaches this
        // from a Playwright global setup, which node runs.
        await glue.default({
            module_or_path: await readFile(wasmArtifact("testing/truapi_server_bg.wasm")),
        });
        return glue;
    })();
    return loaded;
}
/**
 * The SS58 address of the product account `query` names.
 *
 * Encoded at the prefix the core mandates, which is not necessarily the one a
 * product displays. Pass it to a faucet or a transfer as it stands.
 *
 * Needs the built WASM bundle; see `wasmIsBuilt`.
 */
export async function productAccountAddress(query) {
    const { entropy } = resolveAccount(query.account);
    // The index crosses SCALE-encoded, so the chain code stays core-owned.
    const index = DerivationIndex.enc({
        tag: "Index",
        value: checkDerivationIndex(query.index ?? 0),
    });
    const core = await derivation();
    const subtree = core.deriveProductSubtreePublicKey(entropy, query.productId);
    return core.productAccountAddress(core.deriveProductAccountPublicKey(subtree, index));
}
