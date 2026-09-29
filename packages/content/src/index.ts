// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Public API of @dotli/content. Other workspace packages import only from here;
// every other module under src/ is private to the package.

export {
  packArchive,
  parseIpfsResponse,
  type ArchiveFiles,
} from "./archive.js";
export {
  bitswapGet,
  listenForSandboxBitswap,
  onContentProgress,
} from "./bitswap.js";
export { decryptContent, isEncrypted } from "./decrypt.js";
export { type FetchResult } from "./fetch.js";
export { fetchFromIpfs } from "./ipfs.js";
export { computePreimageKey, hashToCid } from "./preimage.js";
export { assertBlockMatchesCid } from "./verify.js";

// Lazy entry points. Each module is its own chunk, fetched on first call;
// a static re-export here would pull it into every importer's bundle.
export type FetchModule = typeof import("./fetch.js");
export const loadFetch = (): Promise<FetchModule> => import("./fetch.js");
