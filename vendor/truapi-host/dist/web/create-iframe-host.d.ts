/**
 * Options for `createIframeHost`.
 */
export interface IframeHostOptions {
    /** URL of the product iframe. */
    iframeUrl: string;
    /** Container element the iframe is appended to. */
    container: HTMLElement;
    /**
     * Called with one end of the MessageChannel once the iframe has loaded.
     * Hosts typically pipe this into a `WireProvider` (e.g. via
     * `createMessagePortProvider` from `@parity/truapi`).
     */
    onPort: (port: MessagePort) => void;
    /**
     * Optional explicit allow-list origin. Defaults to the origin of
     * `iframeUrl`. Throws if it disagrees with the iframe URL's origin.
     */
    allowedOrigin?: string;
    /** Optional iframe Permissions Policy allow attribute. */
    allow?: string;
    /** Override the default iframe sandbox attribute. */
    sandbox?: string;
}
/**
 * Handle returned by `createIframeHost`.
 */
export interface IframeHost {
    iframe: HTMLIFrameElement;
    dispose: () => void;
}
/**
 * Embed a product iframe and transfer a `MessagePort` into it. The host
 * keeps the other end and passes it to a `WireProvider` (typically via
 * `createMessagePortProvider`). All product traffic flows over the
 * MessageChannel.
 */
export declare function createIframeHost(options: IframeHostOptions): IframeHost;
export type { WireProvider } from "@parity/truapi";
