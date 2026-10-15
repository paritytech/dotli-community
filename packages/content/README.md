# `@dotli/content`

Fetches a product's files by CID and proves they are the content the CID names, so an untrusted gateway or peer is never
in the trust path.

## Responsibility

- Owns fetching from an IPFS gateway or from a block source, walking the UnixFS DAG and packing the files.
- Owns the hash check of a block against its CID, and decryption of encrypted content. It runs the check on every
  gateway block itself. On the Bitswap source the host's block relay runs it on every block.
- Does not own block transport over the light client or the block cache.

## Design

```mermaid
flowchart LR
  cid[CID] --> fetch["fetch: gateway or injected block source"]
  fetch --> verify["verify: hash each block"] --> archive["archive: walk, pack"]
```

- Fetching picks one source and never falls back from one to the other. The Bitswap source is passed in as a
  block-fetching function, so this package does not import the transport.
- The gateway path calls the active network's gateway and fetches a CAR or raw bytes.
- Verification recomputes each block hash (sha2-256 or blake2b-256) and throws `ContentVerificationError`. Gateway
  content is verified block by block here. On the Bitswap source the host's block relay is the one per-block check: it
  hashes every block before the sandbox sees it and refuses one it cannot check. The walk here re-hashes only the root,
  which ties what the relay served to the CID the sandbox was given.
- The archive step reads CAR files and UnixFS directories into `ArchiveFiles`, a path to bytes map.
- Decryption handles content in the layout external tooling writes, with ChaCha20-Poly1305.
- Error names are kept apart from the code that throws them. Callers branch on `error.name`, since errors are rebuilt
  across `postMessage`.
- The entry is pure re-exports so the bundler drops unused ones. Verification pulls the hash code, so the host's eager
  path loads it through a lazy loader.

## Public API

### `@dotli/content`

- Fetch and archive: `fetchArchive`, `readArchiveFiles`, `fetchFromIpfs`, `packArchive`, `parseIpfsResponse`,
  `ArchiveFiles`, `FetchResult`.
- Verification: `assertBlockMatchesCid`, `CONTENT_ERRORS`.
- Encryption and CIDs: `isEncrypted`, `decryptContent`, `hashToCid`.
- Lazy loader: `loadVerify` loads the verify module on first use.
