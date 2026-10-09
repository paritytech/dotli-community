/** Absolute path of a file inside the built `dist/wasm` tree. */
export declare function wasmArtifact(relativePath: string): string;
/**
 * Whether the WASM bundles are built.
 *
 * Throws instead of returning `false` when `REQUIRE_WASM=1`, so a suite that
 * would otherwise skip fails the run and names the fix.
 */
export declare function wasmIsBuilt(...relativePaths: string[]): boolean;
