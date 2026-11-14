import type { MediaAudioRoute, MediaRect } from "@parity/truapi";
import type { MediaBackendCommand, MediaConsentRequest, MediaPlatform, MediaRevokedPermission, MediaRevocationSource } from "../generated/host-callbacks.js";
type OperationId = Extract<MediaBackendCommand, {
    tag: "CommitOperation";
}>["value"]["operationId"];
/** Coordinates are in the trusted compositor mount's CSS coordinate system. */
export interface BrowserMediaGeometry {
    left: number;
    top: number;
    /** Logical product viewport size, before the uniform mount-space scale. */
    width: number;
    height: number;
    scale: number;
    /** Physical pixels per product logical pixel, including visual viewport zoom. */
    deviceScale: number;
    /** Host-approved visible rectangle in product logical coordinates. */
    clip: MediaRect;
    visible: boolean;
}
/**
 * Trusted host integration only. Never construct these options from a product
 * request or expose this object, backend, media elements, or callbacks to a product.
 *
 * SECURITY REQUIREMENTS (discovery cannot establish these):
 * - window/document must be the privileged host realm, not the product realm.
 * - The product must be in a separately isolated iframe/Gecko browser. Same-origin
 *   unsandboxed iframes, a product in the host document, and a closed shadow root
 *   alone are NOT isolation. Prevent product access to host DOM and JS, host
 *   capture APIs, and product-facing screenshot/renderer APIs that include these
 *   sibling planes. Independent product RTCPeerConnection use may remain
 *   available; it must never receive host Media tracks, SDP, ICE, keys, or frames.
 *   HTML iframes must explicitly deny microphone, camera, display-capture and
 *   fullscreen in their allow attribute. Keep that isolation across every
 *   navigation; a host origin must never serve product-authored executable code.
 * - getCompositorMount returns the product element's immediate, trusted parent.
 *   It is a positioned isolated stacking context. The complete product element
 *   is a positioned stacking context at z-index 1, planes occupy 0 and 2. Trusted
 *   chrome and indicatorMount must be ABOVE that entire context. Do not permit
 *   product fullscreen/top-layer content to cover or intercept trusted controls.
 * - All mounts remain host-owned. The indicator remains visible and interactive
 *   even for hidden/detached/background products; it is not inside a product view
 *   or a compositor mount that can be hidden with the product.
 * - Supply measureViewport for transformed/clipped native embeddings. Its clip
 *   must include every host occlusion and approved visible region, never enlarge
 *   product visibility. Only axis-aligned uniform transforms are representable.
 *
 * isProductIsolated is a host policy assertion, not a heuristic origin check.
 * It must account for the current navigation/sandbox/process and screenshot
 * policy protecting host Media, not require a blanket product RTC prohibition.
 * A host must detach before replacing/navigation-changing an attachment.
 */
export interface BrowserMediaBackendOptions {
    window: Window;
    document: Document;
    /**
     * Trusted conversion of plain WebIDL dictionaries into window's realm.
     * Required for Gecko system-module/Xray callers: (value) => Cu.cloneInto(value,
     * window). Same-realm browser hosts omit it. Values include private ICE/SDP;
     * this callback and its results must never be exposed to product code.
     */
    toWebIdlValue?<T>(value: T): T;
    productId: string;
    getProductElement(runtimeId: bigint): Element | null;
    getCompositorMount(runtimeId: bigint): Element | null;
    isProductIsolated(product: Element, runtimeId: bigint): boolean;
    indicatorMount: Element;
    /**
     * Mandatory trusted consent UI, not a product permission prompt. Return a
     * boolean only for an actual user answer. Dismissal must reject AbortError,
     * never return false. AbortSignal must synchronously dismiss pending UI,
     * including UI scheduled to mount later. Settle only after that UI is removed.
     * The core alone caches/persists decisions; this hook must not persist grants,
     * grant raw iframe capture permissions, change independent RTC policy,
     * navigate, or reload the product.
     */
    requestConsent(request: MediaConsentRequest, context: BrowserMediaConsentContext): Promise<boolean>;
    /**
     * Host-owned TURN configuration; credentials never enter product values.
     * Peers are always relay-only, so this must name a reachable TURN relay.
     */
    iceServers: readonly RTCIceServer[] | ((runtimeId: bigint) => Promise<readonly RTCIceServer[]>);
    measureViewport?(product: Element, mount: Element, runtimeId: bigint): BrowserMediaGeometry | undefined;
    /** Advisory preference, resolved only against trusted host device knowledge. */
    resolveAudioOutput?(preference: MediaAudioRoute | undefined): Promise<{
        sinkId: string;
        route: MediaAudioRoute;
    } | undefined>;
}
/** Operation identity and cancellation owned by the trusted host runtime. */
export interface BrowserMediaConsentContext {
    readonly productId: string;
    readonly runtimeId: bigint;
    readonly operationId: OperationId;
    readonly signal: AbortSignal;
}
export interface BrowserMediaBackend extends MediaPlatform {
    /** Authorize the current host-selected product attachment for this runtime. */
    attach(runtimeId: bigint): void;
    /** Clear every layout and advance the viewport epoch; audio continues. */
    detach(runtimeId: bigint): void;
    /** Call synchronously when native embedding geometry/occlusion changes. */
    refreshViewport(runtimeId: bigint): void;
    /**
     * Trusted permission integration. Settings revocation defaults to Product;
     * native OS observers must pass OperatingSystem to preserve the core grant.
     */
    revokePermission(runtimeId: bigint, permission: MediaRevokedPermission, source?: MediaRevocationSource): void;
    dispose(): void;
}
/** A host-only DOM/Gecko implementation. No raw media leaves this closure. */
export declare function createBrowserMediaBackend(options: BrowserMediaBackendOptions): BrowserMediaBackend;
export {};
