import type { VersionEntry } from "./data-types.js";
export type { VersionEntry } from "./data-types.js";
/**
 * Version string declared in `js/packages/truapi/package.json` at codegen
 * time. Mirrors the `truapi` crate version. Used by the explorer to render
 * the `main` selector label as `main (x.y.z)`.
 */
export declare const packageVersion = "0.14.0";
export declare const versions: VersionEntry[];
