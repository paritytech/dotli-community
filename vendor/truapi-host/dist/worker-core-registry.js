// Frame and dispose lifecycle for worker-hosted product cores, extracted from
// the worker entry so the borrow ordering (a dispose must await in-flight
// receiveFrame calls before free) is unit-testable without the worker's
// `self`-bound module.
/**
 * Run one receiveFrame, tracking it in `inFlightFrames` so a concurrent dispose
 * can await it before freeing. A receiveFrame failure propagates to the caller.
 */
export async function dispatchFrame(core, coreId, bytes, inFlightFrames) {
    const frame = core.receiveFrame(bytes);
    let pending = inFlightFrames.get(coreId);
    if (!pending) {
        pending = new Set();
        inFlightFrames.set(coreId, pending);
    }
    const tracked = frame.then(() => { }, () => { });
    pending.add(tracked);
    try {
        await frame;
    }
    finally {
        pending.delete(tracked);
        if (pending.size === 0)
            inFlightFrames.delete(coreId);
    }
}
/**
 * Dispose a core, then free it. `dispose()` aborts in-flight dispatch, but
 * wasm-bindgen releases the core's borrow only once the aborted receiveFrame
 * promise settles, so calling free() in the same turn throws "attempted to take
 * ownership of Rust value while it was borrowed" and leaks the core. Await the
 * tracked frames first.
 */
export async function disposeAwaitingFrames(core, coreId, inFlightFrames) {
    try {
        core.dispose();
        const pending = inFlightFrames.get(coreId);
        if (pending && pending.size > 0)
            await Promise.all([...pending]);
        core.free();
    }
    finally {
        inFlightFrames.delete(coreId);
    }
}
