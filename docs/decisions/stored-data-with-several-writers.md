# Stored data with several writers

A developer finds that one set of stored data, such as a cached copy of something the network publishes, has more than
one writer. The writers may accept what they write by different rules, and they may turn out to share one database, for
example because they run on one origin. One writer can overwrite what another relies on. The question is whether to keep
the writers' data apart, with a store, a record key or a database per writer, or to keep one copy and make the writers
agree on it.

## How to resolve

1. Treat it as one set of data, so the device keeps one copy of it. For one writer, do not add any of these:
   - a second store
   - a writer key on the records
   - a database of its own
2. Name the fault as several writers with no coordination, not as a shared copy.
3. Coordinate the writers, with a lock or another technique, so each write follows one rule that keeps the copy right for
   every writer.
4. Give each writer a named write of its own on the one store, and have each decide inside its own transaction or lock.
   Do not make one write that takes the writer as a parameter.

The owner said that one set of data has one copy per device, and that several writers of it are coordinated, such as
with locks, rather than given copies of their own. The owner had the example show one named write per writer, as the
code and [shared-reader-whose-consumers-confirm-copies-differently](shared-reader-whose-consumers-confirm-copies-differently.md)
do, once a review found it showing one write with a writer parameter.

## Example

```ts
// one store of the copy, one named write per writer, each deciding under the same lock
export async function keepCheckedCopy(copy: SignedCopy) {
  await navigator.locks.request('copies', async () => {
    if (await confirmedCopyHeld(copy.network)) return; // the confirming writer's copy stays
    if (await newerCopyHeld(copy)) return;
    await copies.put(copy);
  });
}

export async function keepConfirmedCopy(copy: SignedCopy) {
  await navigator.locks.request('copies', async () => {
    if (await newerCopyHeld(copy)) return;
    await copies.put(copy);
  });
}
```

Not this:

```ts
// a copy per writer, so the data exists twice on one device
const checkedCopies = openStore('copies-checked');
const confirmedCopies = openStore('copies-confirmed');
await copies.put({ key: [network, writer], copy }); // or a writer key on one store
await keepCopy(copy, writer); // or one write that takes the writer
```

## Cases

- Two readers of one stored signed descriptor, one for a core runtime and one for a light-client engine, store copies by
  different acceptance rules and turn out to share one origin, and so one IndexedDB database, where the core's write
  could replace a copy the engine had accepted. Offered a second object store per reader, one store keyed by reader as
  well as network, or a database of the engine's own, the owner chose none of them: one copy per device, with the
  writers coordinated. (docs/\_plans/stack-store-writers-design.md, from reduce/stack-reader-stored-copy round 3 finding
  P1)
- A review of the same change found this rule's example coordinating through one write that took the writer as a
  parameter, while the code kept one named write per writer and the related reader rule adds no parameter naming who
  confirms. The owner had the example fixed to one named write per writer. (feat/stack-reader-stored-copy,
  docs/\_reviews/stack-store-writers-review.md, doc-update proposals)

Status: active
