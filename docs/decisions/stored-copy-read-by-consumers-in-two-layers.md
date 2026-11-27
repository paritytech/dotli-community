# A stored copy read by consumers in two layers

A developer adds a policy for reading an input that consumers start from, such as which of a stored copy and a build
copy to start from and when to fetch and store the live one. Two consumers follow the same policy, and they sit in
different layers. One is in a low-level package that may not import the storage package and gets its inputs through
deps the app's entries build. It may already keep an IndexedDB database of its own. The other is booted by a top-level
app that may import the storage package. They run on different origins, so each keeps its own stored copy. The question
is where the policy lives and where each consumer's stored copy lives:

- the policy in the package that owns the input, taking a store as a parameter, with each consumer's copy in a database
  that consumer's layer already has
- one store in the storage package with the policy beside it, used by both consumers
- no shared policy, with a small reader and store in each consumer

## How to resolve

1. Put one store for the stored copy in the storage package, and put the policy beside it in the same package.
2. Do not split the policy from the store into the package that owns the input, and do not give each consumer its own
   reader and store.
3. Keep the low-level consumer's copy out of its own database, even when it has one.
4. Let the top-level app use the storage package's store directly. It writes its own copy on its own origin.
5. For the low-level consumer, have each app entry that builds its deps build the reader from the storage package's
   store and pass it in, as
   [per-network-input-a-low-level-package-may-not-load](per-network-input-a-low-level-package-may-not-load.md) passes a
   loader for the active network. When that consumer also keeps records beside the copy, such as files the copy names,
   read and write them through the same reader, so the entry passes the reader alone and adapts no second store.

The owner chose this without stating a reason. The storage package is where the app's other IndexedDB databases and
stores already live, and the policy stays with the store it reads and writes rather than with either consumer. The owner
put the policy there although the storage package otherwise leaves what to cache to its callers. What the policy
itself does is [build-copy-of-signed-data-the-network-republishes](build-copy-of-signed-data-the-network-republishes.md).
When the two consumers differ in whether they can confirm a fetched copy themselves, the storage package exports a named
reader for each, as
[shared-reader-whose-consumers-confirm-copies-differently](shared-reader-whose-consumers-confirm-copies-differently.md)
says. That rule also says how the records kept beside the copy come through the reader.

## Example

```ts
// storage package: one store and the policy that reads it
export function createManifestReader(sources: ManifestSources) {
  const store = manifestCopies();
  return { read: (network: Network) => readWithPolicy(store, sources, network) };
}

// each app entry that builds the low-level package's deps
const manifests = createManifestReader(manifestSources);
const engine = createEngine({ readManifest: () => manifests.read(activeNetwork) });

// the top-level app, on its own origin
const runtime = bootRuntime({ manifest: await createManifestReader(manifestSources).read(activeNetwork) });
```

Not this:

```ts
// config package: the policy apart from its store
export function readManifest(store: CopyStore) { /* ... */ }

// low-level package: its copy in its own database
const engine = createEngine({ readManifest: () => readManifest(engineDbCopies()) });

// each entry adapts a second store for what is kept beside the copy
const engine = createEngine({ readManifest, keptFiles: { get: () => fileStore.get(activeNetwork) } });
```

## Cases

- A per-network signed descriptor the config package bundles and the network re-publishes is the start of a light-client
  engine in the chains package, which has its own IndexedDB database for engine snapshots, and of the core runtime the
  host boots, on another origin. Offered the policy in the config package with a store parameter, one store with the
  policy in the storage package, or a reader per consumer, the owner chose the store and the policy in the storage
  package. (docs/\_plans/stack-reader-cache-design.md)
- The light-client engine's spec files, kept beside the descriptor, were read and written through a spec store both
  protocol entries adapted. The owner chose one write for the descriptor and its specs, with the offer reader handing
  over the held specs, so the entries pass the reader alone. (reduce/stack-reader-stored-copy, reduce-complexity round,
  proposal O1)

Status: active
