import { Err, Ok, ResultAsync } from "neverthrow";
export { createHostConnection, } from "./host-connection.js";
export { createInternalClient, } from "./generated/internal-client.js";
/** Protects result handling when host authorization shares the product's realm. */
export function freezeInternalResults() {
    for (const constructor of [Err, Ok, ResultAsync]) {
        Object.freeze(constructor.prototype);
        Object.freeze(constructor);
    }
}
