# `@dotli/resolver`

Resolves a `.dot` name to its manifests and content hash by reading the dotNS contracts, and owns the dotNS naming rules
every caller checks a name against.

## Responsibility

- Owns dotNS reads: Registry and ContentResolver storage, contenthash decoding and manifest records.
- Owns the wait for a chain to sync before a read, and the errors a resolution fails with.
- Owns the dotNS naming rules: which hosts are products under the active network's TLD, what a valid label is, and the
  manifest kinds a product publishes.
- Does not own the chain connections it reads through, content fetching or the cached label to CID map.

## Design

- The resolver works over one Asset Hub client, created on first use and again after its follow stops. The connection is
  passed in, so it reads through the follow its owner already keeps. Work runs in named `createAsyncTaskPool` pools.
- Contract reads go straight to Revive storage slots with no runtime call. Multi-slot reads pin one block and the
  contract's trie id, so bytes are never torn across blocks. Slot math and contenthash decoding sit in their own part.
- Manifest records are read as text and checked by handwritten validators, kept apart so the eager path does not pull
  the chain-storage code.
- A read on a halted chain is retried on the rebuilt chain a bounded number of times. The resolver knows the halt by the
  marker the chain pool puts on its answers, and repeats that marker rather than import the pool.
- Waiting for sync races `whenReady()` against a timer, since it never settles without peers.
- Error names are read verbatim by dashboards and Sentry filters.
- The naming rules are small pure helpers with no chain access. The URL helpers read the active network's TLD to tell a
  product host from a website.
- The resolver is heavy, so it loads through a lazy loader. The entry is pure re-exports, so the bundler drops what a
  caller does not take.

## Public API

### `@dotli/resolver`

- Resolving: `createDotnsResolver`, `DotnsResolver`, `DotnsResolverDeps`, `ResolveOptions`, `ResolvePhase`,
  `DotnsResolverStatus`, `DotnsResolverStatusStore`, `ChainClient`.
- Manifests: `toRootManifestResult`, `toExecutableManifestResult`, `RootManifest`, `ExecutableManifest`,
  `ManifestResult`.
- Naming rules: `dotNsUrl`, `validateDotLabel`, `isValidDotLabel`, `DotLabelResult`, `isExecutableKind`.
- Errors: `ResolverErrorName`.
- Lazy loader: `loadResolve`.
