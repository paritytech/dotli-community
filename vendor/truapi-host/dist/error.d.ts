/** Coerce an unknown thrown value into a human-readable message string. */
export declare function errorMessage(err: unknown): string;
/** Coerce an unknown thrown value into an `Error`, keeping one it already is. */
export declare function toError(err: unknown): Error;
