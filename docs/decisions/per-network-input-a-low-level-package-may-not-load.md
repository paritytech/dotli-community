# A per-network input a low-level package may not load

A developer builds a component in a low-level package, and it needs an input that differs per network, such as the
active network's signed descriptor, when it starts. The config package already has a loader for it in its main entry.
Some files of the low-level package may import only the config package's fixed entry, which lint enforces, because one
context they run in never receives the runtime config. The component is built through a deps object that the app's
entries create, and each entry knows the active network by the time the input is read. The question is how the
component gets the input:

- its deps take a loader function, which each app entry builds from the active network with the existing loader
- the component loads the input itself, with the loader moved into or re-exported from the fixed entry
- the package's own deps factory builds the loader from the active network, so the app's entries do not change

When the input comes through a reader that another package holds, a second question is whether that reader is bound to
one network when the entry builds it, or takes the network on each read.

## How to resolve

1. Leave the loader where it is in the config package, and leave the lint restriction on the low-level package.
2. Add a function to the component's deps that returns the input for the active network, with no network parameter.
3. In each app entry that builds the deps, bind the config package's existing loader to the active network the entry
   knows, and pass the bound function. When the input is read through a stored copy held by a package the low-level one
   may not import, the entry builds that package's reader and passes a function that reads it for the active network.
4. Keep the network a parameter of that reader's read, rather than binding the reader to one network when the entry
   builds it. An entry may build its reader before it knows its network, such as in a chunk that loads before the
   settings settle, or in a context whose network comes from a parse that can fail. Binding at construction would then
   need a module-scope getter for the network or a placeholder reader for the failed parse.
5. Do not move or re-export the loader into the fixed entry, and do not have the low-level package's deps factory pick
   the network.

The owner chose this without stating a reason. The low-level package then reads nothing per network itself, and the
entries that already know the network are the ones that choose what to load. For the reader, the owner chose the
network per read over a reader bound at construction, without stating a reason, when shown that one entry builds it in
a chunk that must not depend on the settings and another knows its network only after a parse that can fail.

## Example

```ts
// low-level package: the component takes the input from its deps
export interface EngineDeps {
  readonly loadManifest: () => Promise<SignedManifest>;
}

export function createEngine({ loadManifest }: EngineDeps) {
  return { start: async () => boot(await loadManifest()) };
}

// each app entry, which knows the active network when the input is read
const engine = createEngine({ loadManifest: () => loadNetworkManifest(activeNetwork) });

// an entry reading through another package's reader, built once, the network passed per read
const manifests = createManifestReader(manifestSources);
const engine = createEngine({ loadManifest: () => manifests.read(activeNetwork) });
```

Not this:

```ts
// The low-level package reaches for the loader itself, which its restricted files may not import.
import { loadNetworkManifest } from '@acme/config/fixed';
const manifest = await loadNetworkManifest(currentNetwork());

// The reader bound at construction, with a placeholder for a context whose network failed to parse.
const manifests = parsed.ok ? createManifestReader({ network: parsed.value }) : null;
```

## Cases

- A light-client component in a low-level package needed the active network's signed descriptor to start its engine.
  The config package's main entry held a loader that reads no overridable field and loads one lazy chunk per network,
  while some of the package's files were lint-restricted to the fixed entry because a SharedWorker serving every tab
  never receives the runtime config. The deps were built by the app's two entries, an iframe page and that SharedWorker.
  Offered a loader in the deps, the loader moved into the fixed entry, or the package's deps factory building it, the
  owner chose the loader in the deps. (Sentry DOTLI-N5, docs/\_plans/truapi-provider-stack-design.md)
- The same descriptor came to be read through a stored copy whose store and policy the owner put in the storage
  package, which the low-level package may not import. The app's entries build that reader and pass it in the deps.
  (docs/\_plans/stack-reader-cache-design.md)
- A simplification round proposed binding the storage package's descriptor readers to one network at construction. The
  host's bridge chunk builds one and loads before the settings settle, and in debug mode before the host starts, with a
  comment that it must not depend on them. The SharedWorker knows its network only once it parses, which can fail.
  Offered a reader bound by each entry or the network passed per read, the owner chose the network per read.
  (reduce/stack-reader-stored-copy, reduce-complexity round, proposal O2)

Status: active
