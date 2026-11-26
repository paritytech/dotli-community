# A start input the network fails to serve

A developer builds a component that starts lazily, such as an engine started on its first use. Before it can serve its
items it needs a small input per item, fetched from the network, and some items also need another item's input. The
component already has a start-failure path: a failed start, such as a failed download of its main binary, makes it fatal
and the layer above rebuilds it. The engine could also take an input after it was built. The question is what happens
when one of those inputs cannot be fetched:

- fetch every input at start, retried, and fail the start when one still fails
- start with the inputs that loaded and fetch a failed one again when a consumer next asks for its item
- fetch each item's input only when a consumer first asks for it, and let a failure halt that item alone

## How to resolve

1. Fetch every input the component's start needs when it starts, not when a consumer first asks for an item.
2. Retry each fetch through the shared async task pool, so a passing network fault does not fail the start.
3. When an input still fails after its retries, fail the start through the component's existing start-failure path,
   the same way a failed download of its main binary does, and let the layer above recover as it already does.
4. Add no partial start, no refetch on a later open and no per-item failure state.

The owner chose this without stating a reason. A missing input then fails the way the component's other start inputs
already fail, so the layer above keeps one recovery path and the component has no half-started state.

## Example

```ts
async function startEngine(descriptor: Descriptor, pool: AsyncTaskPool) {
  const binary = await pool.run(() => fetchBinary(descriptor.binaryUrl));
  // A spec that still fails after its retries rejects the start, as a failed binary does.
  const specs = await Promise.all(descriptor.items.map((item) => pool.run(() => fetchSpec(item.specUrl))));
  return createEngine(binary, specs);
}
```

Not this:

```ts
// The engine starts half-built, and each item grows its own failure and refetch path.
const specs = await Promise.allSettled(descriptor.items.map((item) => fetchSpec(item.specUrl)));
const engine = createEngine(binary, loaded(specs));
engine.onOpen((item) => (engine.has(item) ? undefined : refetchAndAdd(engine, item)));
```

## Cases

- A light client starts its engine on the first chain opened, and the engine needs each chain's small spec file, plus
  its relay's for a parachain, fetched from URLs a signed descriptor names. A failed engine start already made the light
  client fatal and the layer above rebuilt its frame. Offered every spec at start with a fatal failure, a start with the
  specs that loaded and a refetch on the next open, or each spec fetched on its chain's first open with a failure that
  halts that chain alone, the owner chose every spec at start with a fatal failure. (Sentry DOTLI-N5,
  docs/\_plans/truapi-provider-stack-design.md)

Status: active
