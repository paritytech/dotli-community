/**
 * Legacy Nova iframe transport compatibility.
 *
 * Delete this module together with the marked fallback in `sandbox.ts` once
 * every iframe host transfers a `MessagePort` in response to `truapi-ready`.
 * The inbound `host_handshake_request` compatibility handler in `client.ts`
 * can be removed at the same time.
 *
 * @internal
 */
import type { WireProvider } from "./transport.js";
export interface LegacyIframeProvider {
    provider: WireProvider;
    initialMessage: Uint8Array;
}
/**
 * Recognize a legacy host's first raw SCALE frame and create a provider pinned
 * to that frame's parent window and origin. Modern bootstrap messages return
 * `null` without changing any state.
 */
export declare function tryCreateLegacyIframeProvider(win: Window, target: Window, event: MessageEvent): LegacyIframeProvider | null;
