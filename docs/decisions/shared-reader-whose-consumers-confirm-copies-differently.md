# A shared reader whose consumers confirm a fetched copy differently

A developer builds one reader that starts each consumer from a stored copy and fetches a newer signed copy behind the
start. The consumers differ in whether they can confirm a copy themselves. One cannot check a copy without starting from
it, so the reader's own signature check is all it has. The other checks every copy itself, and may also need files the
copy names fetched and stored before the copy is any use on a later start. Storing a copy before that consumer accepted
it and its files leaves a later start with a copy it cannot use, such as during an outage. The question is who decides
when a fetched copy is stored, and, when nothing is stored yet and the start runs from a copy fetched for it, which
starting copies carry a call that stores them:

- two named readers that share one policy, each deciding the store its own way
- every reader hands back the newer copy and whether its signature verified, and each caller stores it
- one reader with a parameter naming who confirms the copy

## How to resolve

1. Keep one policy for the start and the fetch behind it, shared by both readers.
2. Export one named reader per way of confirming a copy, each a factory of its own:
   - for a consumer that cannot confirm a copy, a reader that stores the newer copy itself once the checks of
     [build-copy-of-signed-data-the-network-republishes](build-copy-of-signed-data-the-network-republishes.md) step 4
     pass
   - for a consumer that confirms a copy itself, a reader that hands back every fetched copy it has not stored with a
     call that stores it, even where the platform cannot check its signature. That is the newer copy fetched behind the
     start, and the starting copy when nothing was stored and the start waited for the live fetch.
3. Give a store call only to a fetched copy the reader has not stored. A start from the stored copy or from the build
   copy carries none, and the type of what the reader hands back tells the kinds apart, so nothing is written on a start
   that changed nothing.
4. Have the consumer that confirms call the store only once it accepted the copy and stored the files the copy names.
5. Add no parameter that names who confirms the copy, and do not make every caller store the copy.

The owner chose the two named readers without stating a reason. The consumer that confirms a copy is the only one that
knows when the copy and its files are safe to start from, and the consumer that cannot confirm keeps its reader as it
was. A platform that cannot check the signature still lets the confirming consumer recover from the live copy, since its
own check decides. For the starting copy, the owner chose that only a fetched copy carries the store call over every
starting copy carrying one that the consumer always calls, without stating a reason.

## Example

```ts
// storage package: one policy, two named readers
export function createCheckedCopyReader(sources: CopySources) {
  return readWithPolicy(sources, { onNewer: copy => storeIfSignatureVerifies(copy) });
}

export function createUnstoredCopyReader(sources: CopySources) {
  return readWithPolicy(sources, { onNewer: copy => ({ copy, save: () => storeCopy(copy) }) });
}

// what the confirming reader starts a consumer from
type Start =
  | { source: 'stored' | 'bundled'; copy: SignedCopy }
  | { source: 'fetched'; copy: SignedCopy; save: () => Promise<void> };

// a consumer that checks every copy and the files it names
const start = await reader.start();
const engine = await createEngine(start.copy);
if (start.source === 'fetched') {
  await storeNamedFiles(start.copy);
  await start.save();
}
const newer = await reader.newer();
if (newer && (await engine.accept(newer.copy))) {
  await storeNamedFiles(newer.copy);
  await newer.save();
}
```

Not this:

```ts
createCopyReader(sources, { confirm: 'consumer' }); // the reader takes a mode
const { copy, verified } = await reader.newer(); // every caller decides the store
if (verified) await storeCopy(copy);
const start = await reader.start();
await start.save(); // every start rewrites the stored copy, even one that changed nothing
```

## Cases

- One reader in the storage package starts a core runtime the host boots and a light-client engine in the chains
  package, on different origins, from a stored signed descriptor and fetches the live one behind each start. The core
  has only the reader's WebCrypto Ed25519 check, while the engine checks every descriptor and needs the spec files it
  names stored separately. A review found that storing a descriptor before the engine accepted it and its files broke a
  later start during an outage, and that on a platform without Ed25519 the engine lost its recovery from the live copy.
  Offered two named readers sharing one policy, the caller storing from every reader, or one reader with a mode
  parameter, the owner chose two named readers. (docs/\_plans/stack-reader-cache-design.md,
  docs/\_reviews/stack-reader-cache-review.md B1 and M1)
- The same reader for the light-client engine, with no stored descriptor, starts the engine from the descriptor it just
  fetched, which may not be stored before the engine accepted it and stored its spec files. Offered a store call on the
  fetched, unstored starting copy only, told apart from a stored or bundled start by the result's type, or a store call
  on every starting copy that the engine always calls, the owner chose only the fetched copy.
  (docs/\_plans/stack-reader-cache-design.md, docs/\_reviews/stack-reader-cache-review.md M1)

Status: active
