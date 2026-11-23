# Code reads or writes web storage

A developer keeps a value in the tab's local or session storage, such as a marker that something already happened. The
code reads and writes it with direct calls on the injected `SafeStorage`. The repo's persist adapter keeps a nanostores
atom in storage, but it lacks something the value needs, such as telling whether a write stuck when storage is blocked
or full. The question is whether the value stays on direct storage calls, moves onto the existing adapter and gives up
what it lacks, or gets an adapter that has it.

## How to resolve

1. Read and write the value through a nanostores atom, never through direct `SafeStorage` reads and writes in the code
   that uses it.
2. Back the atom with an adapter from nanostores to `SafeStorage`.
3. When the existing persist adapter lacks what the value needs, add an adapter that has it, rather than keeping the
   direct calls or dropping the need.
4. Migrate the code to the atom, so the direct calls go.

The owner wants direct storage reads and writes replaced by a nanostores atom over a persist adapter, and when the
existing adapter does not fit, asked for a new adapter from nanostores to `SafeStorage` and a migration to it. The new
adapter's API was still being worked out when this was recorded.

## Example

```ts
// The value lives in an atom over a SafeStorage adapter. The code that uses it touches no storage.
const $digestSent = createStoredAtom({ key: 'digest-sent', storage: tabStorage, initial: false });

if (!$digestSent.get()) {
  $digestSent.set(true);
  sendDigest();
}
```

Not this:

```ts
// The code reads and writes storage directly.
if (tabStorage.getItem('digest-sent') === null) {
  tabStorage.setItem('digest-sent', '1');
  sendDigest();
}
```

## Cases

- A once-per-build "update reload claimed" marker in the tab's session storage was read and written through the
  injected `SafeStorage`, with a read-back after the write so blocked storage meant no claim and no reload loop. The
  persist adapter `createPersistentAtom` holds the value in memory and drops a failed write silently, so it could not
  tell whether the claim stuck. The owner first asked that direct storage reads and writes be replaced with a nanostores
  atom and a persist adapter, then, offered to keep the direct calls, to add a readout to the existing adapter or to
  accept a reload loop, asked for a new adapter from nanostores to `SafeStorage` and a migration to it. (PR #508,
  reduce-complexity run on refactor/complexity-mismatch-reload)

Related: [new-outcome-in-an-existing-flow](new-outcome-in-an-existing-flow.md) places the claim in that case.

Status: active
