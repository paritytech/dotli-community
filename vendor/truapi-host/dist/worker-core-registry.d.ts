/** The subset of a product core this module drives. */
export interface DisposableCore {
    dispose(): void;
    free(): void;
    receiveFrame(bytes: Uint8Array): Promise<void>;
}
/**
 * Run one receiveFrame, tracking it in `inFlightFrames` so a concurrent dispose
 * can await it before freeing. A receiveFrame failure propagates to the caller.
 */
export declare function dispatchFrame(core: DisposableCore, coreId: number, bytes: Uint8Array, inFlightFrames: Map<number, Set<Promise<void>>>): Promise<void>;
/**
 * Dispose a core, then free it. `dispose()` aborts in-flight dispatch, but
 * wasm-bindgen releases the core's borrow only once the aborted receiveFrame
 * promise settles, so calling free() in the same turn throws "attempted to take
 * ownership of Rust value while it was borrowed" and leaks the core. Await the
 * tracked frames first.
 */
export declare function disposeAwaitingFrames(core: DisposableCore, coreId: number, inFlightFrames: Map<number, Set<Promise<void>>>): Promise<void>;
