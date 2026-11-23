# `@dotli/stores-persistent`

## Overview

Keeps a nanostores atom in web storage.

## Responsibilities

- **Owns:** `createPersistentAtom` and `createStoredAtom`.
- **Does not own:** which values are kept, or their formats. Nor the storage, which the caller passes with a key and a
  codec.

## Public API

| Export                                                            | What it does                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `createPersistentAtom({ key, storage, initial, decode, encode })` | A writable atom whose `init` is `initial`.            |
| `createStoredAtom({ key, storage, initial, decode, encode })`     | A writable atom that holds only what `storage` keeps. |
| `PersistentAtomParams`                                            | Their options.                                        |

`decode` returns `undefined` for text that no longer parses, which gives the initial value.

## Design

Two atoms, one read and one write. They differ only in whether a write the storage drops aborts the set.

```mermaid
flowchart LR
  storage -- "first start: read once, decode" --> atom[persistent or stored atom]
  atom -- "each set: encode, or remove at initial" --> storage
  storage -- "stored atom only: read back, abort the set when it did not stick" --> atom
```

- **Lazy read:** building the atom reads nothing, so a module may build it at import. Storage is read once, on first
  use.
- **Caller wins:** a set before that read applies after it.
- **Defaults are not stored:** setting the initial value removes the key.
- **No cross-tab sync:** another tab's later write shows only after a reload.
- **Failing storage, persistent atom:** the atom keeps working in memory. Pass a storage that never throws.
- **Failing storage, stored atom:** the atom keeps what the storage holds, so a set the storage drops changes nothing.
- **Which to use:** a value the page shows takes the persistent atom. A value a decision must find again after a reload
  takes the stored atom.
