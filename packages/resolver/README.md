# `@dotli/resolver`

Resolves a `.dot` name to its manifests and content hash by reading the dotNS contracts, and owns the dotNS naming rules
every caller checks a name against.

## Responsibility

- Owns dotNS reads: Registry and ContentResolver storage, contenthash decoding, manifest records and a name's owner,
  which is the record's owner for a subname and else the holder of the name's token in the Registrar.
- Owns the wait for a chain to sync before a read, and the errors a resolution fails with.
- Owns the dotNS naming rules: which hosts are products under the active network's TLD, what a valid label and name are,
  the one DNS label a product's sandbox origin is named by, and the manifest kinds a product publishes.
- Does not own the chain connections it reads through, content fetching or the cached label to CID map.

## Design

- The resolver works over one Asset Hub client, created on first use and again after its follow stops. A follow that
  stops before the client is kept takes it back to idle too. The connection is passed in, so it reads through the follow
  its owner already keeps. Work runs in named `createAsyncTaskPool` pools.
- The client's state, with the client once it is ready, is held in one nanostores atom and replayed to each caller's
  phase callback. A caller hears each change with the status there is when its turn comes, so a read started inside a
  store's listener round can hear the latest phase twice and miss an earlier one. A callback's own throw is reported and
  the build goes on. A throw from a listener of a store the callback writes reaches the build, so such a listener
  catches its own errors.
- Contract reads go straight to Revive storage slots with no runtime call. Multi-slot reads pin one block and the
  contract's trie id, so bytes are never torn across blocks. Slot math and contenthash decoding sit in their own part. A
  multi-slot read asks for its data slots at once. Each follow runs a bounded number of storage operations at a time.
- Manifest records are read as text and checked by handwritten validators, kept apart so the eager path does not pull
  the chain-storage code.
- A read on a halted chain is retried on the rebuilt chain a bounded number of times. The resolver knows the halt by the
  marker the chain pool puts on its answers, a shared wire constant, so it never imports the pool.
- Waiting for sync races `whenReady()` against a timer, since it never settles without peers.
- Error names are read verbatim by dashboards and Sentry filters.
- The naming rules are small pure helpers with no chain access. The URL helpers read the active network's TLD to tell a
  product host from a website.
- A label is lowercase ASCII letters, digits and inner hyphens, and never starts with `xn--`, since a punycode label can
  spell a name in letters that only look like another name's. A registered label has at least 2 characters.
- A name is one label or a subname of several. The labels of a subname below its registered label have no minimum
  length. A wildcard certificate covers one label, so a subname's sandbox label is `sn--` and a hash of the name. No
  label may start with `sn--`, so a registered label never takes a subname's origin.
- A change to the naming rules is checked against the dotNS contracts (paritytech/dotns) before it is designed. The
  rules never refuse a name those contracts can register.
- The resolver is heavy, so it loads through a lazy loader. The entry is pure re-exports, so the bundler drops what a
  caller does not take.

## Public API

### `@dotli/resolver`

- Resolving: `createDotnsResolver`, `DotnsResolver`, `ResolveOptions`, `ResolvePhase`, `ChainClient`.
- Manifests: `toRootManifestResult`, `toExecutableManifestResult`, `RootManifest`, `ExecutableManifest`,
  `ManifestResult`, `AppVersion`.
- Naming rules: `dotNsUrl`, `validateDotLabel`, `isValidDotLabel`, `validateDotName`, `isValidDotName`,
  `getSandboxLabel`, `DotLabelResult`, `isExecutableKind`.
- Errors: `ResolverErrorName`, `isApiStoppedError(error)` (whether a read failed because its chain's follow stopped,
  also for a copy rebuilt under its name).
- Lazy loader: `loadResolve`.
