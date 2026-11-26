# A build copy of signed data the network re-publishes

A component starts from signed data that the network publishes, such as a descriptor a light client starts its engine
from. The repo keeps a hand-refreshed copy of it in the build, and the publisher re-publishes the live one whenever a
part changes, so the build copy can go stale within days. The consumer checks the data and refuses a stale part. The
question is where the component gets data that is current enough to start from:

- start from the build copy and fetch the live data only on a refusal
- fetch the live data on every start and fall back to the build copy
- take an upstream library that holds the copies, refreshes them on its own policy and stores the last fetched one

## How to resolve

1. Start from the build copy, with no network fetch before the start.
2. When the consumer refuses a part of it as stale, fetch the live data once and start again from it.
3. Let the consumer's own check verify the live data, as it does the build copy.
4. Fetch nothing on every start, and take no larger upstream library for a refresh policy the refusal already covers.

The owner chose this without stating a reason. A start pays no fetch while the build copy is current, and the
consumer's refusal is what tells it the copy went stale.

## Example

```ts
async function startEngine(createEngine: (data: SignedData) => Promise<Engine>) {
  try {
    return await createEngine(bundledData);
  } catch (error) {
    if (!(error instanceof StalePartRefused)) throw error;
    return createEngine(await fetchLiveData(bundledData.liveUrl));
  }
}
```

Not this:

```ts
// Every start waits on the network, though the build copy is usually current.
const data = await fetchLiveData(url).catch(() => bundledData);
const engine = await createEngine(data);
```

## Cases

- A context's light client starts from a signed network descriptor whose per-chain spec digests the engine checks. The
  operator re-publishes it with a new sequence whenever a spec changes. Offered the build copy with a refetch on refusal,
  a fetch on every start with the build copy as fallback, or the upstream stack reader library at about 590 KB more
  WebAssembly, the owner chose the build copy with a refetch on refusal. (Sentry DOTLI-N5,
  docs/\_plans/truapi-provider-stack-design.md)

Status: active
