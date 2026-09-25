import type { NativeChatFilesHost } from "../generated/host-callbacks.js";
/** Immutable host-private sources; writes resolve only after durable commit. */
export interface BrowserNativeChatFileSourceStore {
    putSources(sources: readonly {
        sourceId: string;
        blob: Blob;
    }[]): Promise<void>;
    readSource(sourceId: string): Promise<Blob | undefined>;
    releaseSource(sourceId: string): Promise<void>;
}
export interface BrowserNativeChatFilesHost extends NativeChatFilesHost {
    /** Close host UI and cancel partial exports, never release durable sources. */
    dispose(): void;
}
/** Trusted main-window custody. No filename, path or source handle crosses into a Guest. */
export declare function createBrowserNativeChatFilesHost(sourceStore?: BrowserNativeChatFileSourceStore): BrowserNativeChatFilesHost;
