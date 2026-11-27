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

A last question is how the copy and the files the consumer accepted it with reach the store: in one write, or the files
first and the copy only once their write committed, through a separate store each app entry adapts.

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
4. Have the consumer that confirms call the store only once it accepted the copy, and pass it the files it accepted the
   copy with.
5. Have that store call write the copy and its files in one transaction, so a failed write keeps both old records. Do
   not write the files first and gate the copy's write on whether theirs committed.
6. Have the confirming reader also hand back the files the store holds beside the copy, with a call that writes the
   files alone, for a start from the stored or build copy, which carries no store call. The app entries then pass the reader alone,
   with no adapter of their own over the files' store.
7. Add no parameter that names who confirms the copy, and do not make every caller store the copy.
8. Where both readers write on one device, keep one copy for both and coordinate their writes, as
   [stored-data-with-several-writers](stored-data-with-several-writers.md) says.

The owner chose the two named readers without stating a reason. The consumer that confirms a copy is the only one that
knows when the copy and its files are safe to start from, and the consumer that cannot confirm keeps its reader as it
was. A platform that cannot check the signature still lets the confirming consumer recover from the live copy, since its
own check decides. For the starting copy, the owner chose that only a fetched copy carries the store call over every
starting copy carrying one that the consumer always calls, without stating a reason. For the write, the owner chose one
transaction for the copy and its files, with the reader handing over the held files, over ordered writes behind a
committed gate, without stating a reason. One write makes the order hold by itself, so no gate or ordering rule has to
keep it, and the entries stop repeating an adapter over the files' store.

## Example

```ts
// storage package: one policy, two named readers
export function createCheckedCopyReader(sources: CopySources) {
  return readWithPolicy(sources, { onNewer: copy => storeIfSignatureVerifies(copy) });
}

export function createUnstoredCopyReader(sources: CopySources) {
  return readWithPolicy(sources, {
    // the copy and the files its consumer accepted it with, in one transaction
    onNewer: copy => ({ copy, save: (files: NamedFiles) => storeCopyWithFiles(copy, files) }),
    files: { held: readNamedFiles, set: storeNamedFiles },
  });
}

// what the confirming reader starts a consumer from
type Start =
  | { source: 'stored' | 'bundled'; copy: SignedCopy }
  | { source: 'fetched'; copy: SignedCopy; save: (files: NamedFiles) => Promise<void> };

// a consumer that checks every copy and the files it names
const { start, newer, files } = await reader.read();
const engine = await createEngine(start.copy, files.held);
if (start.source === 'fetched') await start.save(engine.files());
else await files.set(engine.files());
const next = await newer;
if (next && (await engine.accept(next.copy))) await next.save(engine.files());
```

Not this:

```ts
createCopyReader(sources, { confirm: 'consumer' }); // the reader takes a mode
const { copy, verified } = await reader.newer(); // every caller decides the store
if (verified) await storeCopy(copy);
const start = await reader.start();
await start.save(); // every start rewrites the stored copy, even one that changed nothing
if (await fileStore.set(engine.files())) await next.save(); // two writes, the copy gated on the files' commit
```

## Cases

- One reader in the storage package starts a core runtime the host boots and a light-client engine in the chains
  package, which can share one origin and so one database, from a stored signed descriptor and fetches the live one behind each start. The core
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
- The engine's spec files went to a spec store that both protocol entries adapted, whose write resolved whether it
  committed, and a fetched descriptor was kept only after its specs' write did. Offered one IndexedDB transaction for the
  descriptor and the specs the engine accepted it with, the offer reader also handing over the held specs so the
  entries' adapters go, or the ordered writes with the committed gate, the owner chose the one transaction. The skip of
  a spec write that matches the held set stayed in the chains package. (reduce/stack-reader-stored-copy,
  reduce-complexity round, proposal O1)

Status: active
