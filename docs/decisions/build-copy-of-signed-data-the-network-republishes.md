# A build copy of signed data the network re-publishes

A component starts from signed data that the network publishes, such as a descriptor a light client starts its engine
from and the files it names. The repo keeps a hand-refreshed copy of it in the build, and the publisher re-publishes the
live one whenever a part changes, so the build copy can go stale within days. The consumer checks the data and refuses a
stale part, and the publisher's servers can be down. The question is where the component gets the data it starts from
and when it fetches the live copy:

- start from a copy the context stored earlier and refresh it behind the start
- wait for the live data on every start, with the stored copy and then the build copy as fallbacks
- start from the stored copy and fetch only on a miss or a refusal

## How to resolve

1. Start from the copy the context stored on an earlier start, with no wait on the network.
2. Fetch the live data alongside that start, on every start.
3. Store the fetched copy for the next start only once the consumer accepts it and the files it names are stored. When
   one reader serves a consumer that confirms a copy and one that cannot, see
   [shared-reader-whose-consumers-confirm-copies-differently](shared-reader-whose-consumers-confirm-copies-differently.md).
4. When the consumer cannot say whether it accepts a copy without starting from it, such as a third-party runtime whose
   start fails on a copy it refuses, check the fetched copy before storing it:
   - its shape
   - that it is newer than the stored copy, such as a higher sequence
   - its signature against the publisher's key, through the platform's own crypto

   Store nothing when a check fails, or when the platform cannot check the signature. A check a little less strict than
   the consumer's own is enough.
5. When the consumer refuses the stored copy, wait for that fetch and start again from it.
6. With no stored copy, wait for the live fetch.
7. Use the build copy only as the worst case, when the live fetch fails.

The owner asked for this order. The stored copy comes first. The live data is then stored for next time. The build copy
is the last fallback. The case shows what it removes: with the publisher's servers failing, a start that needed the network
could not start at all. Where the consumer could not be asked, the owner chose to check a copy before storing it over a
shape check alone, whether a refused start then retried from the build copy or failed as any start does, without stating
a reason. The case weighed that a fetched copy can be wrong with no attacker, such as an error page answered with
success. What a start does when an input it must fetch still fails after its retries is
[start-input-the-network-fails-to-serve](start-input-the-network-fails-to-serve.md). Where the policy and the stored
copy live when consumers in two layers share them is
[stored-copy-read-by-consumers-in-two-layers](stored-copy-read-by-consumers-in-two-layers.md).

## Example

```ts
async function startEngine(store: CopyStore, createEngine: (data: SignedData) => Promise<Engine>) {
  const live = fetchLiveData(liveUrl);
  const stored = await store.read();
  if (stored) {
    try {
      const engine = await createEngine(stored);
      void live.then(data => checkAndStore(store, data), reportRefreshFailure);
      return engine;
    } catch (error) {
      if (!(error instanceof StalePartRefused)) throw error;
    }
  }
  const data = await live.catch(() => bundledData);
  const engine = await createEngine(data);
  if (data !== bundledData) await store.write(data);
  return engine;
}
```

When the consumer cannot be asked without starting it, the page checks the copy itself before it stores it:

```ts
async function checkAndStore(store: CopyStore, data: SignedData, publisherKey: CryptoKey | undefined) {
  const stored = await store.read();
  if (!hasDocumentShape(data) || (stored && data.sequence <= stored.sequence)) return;
  // A platform with no support for the signature's algorithm stores nothing.
  if (!publisherKey || !(await crypto.subtle.verify('Ed25519', publisherKey, data.signature, data.payload))) return;
  await store.write(data);
}
```

Not this:

```ts
// Every start waits on the network, and a down server stops a start the stored copy could serve.
const data = await fetchLiveData(liveUrl).catch(() => store.read() ?? bundledData);
```

## Cases

- A context's light client starts from a signed network descriptor whose per-chain spec digests the engine checks.
  Offered the build copy with a refetch on refusal, a fetch on every start with the build copy as fallback, or the
  upstream stack reader library at about 590 KB more WebAssembly, the owner first chose the build copy with a refetch on
  refusal. The next case overturned where the start gets its data. (Sentry DOTLI-N5,
  docs/\_plans/truapi-provider-stack-design.md)
- The same light client, in an iframe page and a SharedWorker, could not start at all while the descriptor's and the
  specs' servers answered 502. The owner asked to read the stored copy first, then fetch the live one and store it, and
  fall back to the build copy only in the worst case. Offered that, the live data first with the stored copy as
  fallback, or the stored copy alone refreshed on a miss or a refusal, the owner chose the stored copy first with a
  refresh behind it. (docs/\_plans/stack-reader-cache-design.md)
- The host page boots a third-party core runtime in a worker with the same signed descriptor in its boot config, handing
  it the page's stored copy in place of the build copy. The core verifies the Ed25519 signature strictly, and a copy it
  refuses fails the whole boot, while the page cannot ask the core about a copy without booting it. Offered a check
  before storing of shape, a higher sequence and the signature through the browser's WebCrypto, storing nothing where
  the browser lacks Ed25519, or a shape check alone with a retry from the build copy after a failed boot, or a shape check
  alone with a refused copy failing through the existing boot failure path, the owner chose to verify before storing.
  (docs/\_plans/stack-reader-cache-design.md)

Status: active
