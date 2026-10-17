import type { NativeChatPickedFile } from "../generated/host-callbacks.js";
type AttachmentMetadata = NativeChatPickedFile["metadata"];
/** Derive metadata from the durable Blob's bytes, not the original name or File.type. */
export declare function inspectNativeChatFileMetadata(blob: Blob, signal?: AbortSignal): Promise<AttachmentMetadata>;
/** Fixed safe basename and a kind-consistent media whitelist, never a supplied path. */
export declare function nativeChatExportFilename(metadata: AttachmentMetadata): string;
export {};
