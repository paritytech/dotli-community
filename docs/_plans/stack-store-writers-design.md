# Stack store writers

## Frame

In the storage package, the stack store keeps one copy of each network's signed stack per device, and its two writers,
the core's reader and the light client's reader, write it under one rule, so the light client never starts from a copy
it did not accept.

## Goal

- Each network has one stored copy per device, in `stacks`, and one set of light specs, in `light_specs`. No second
  copy, store or key is added.
- On a device where the light client keeps light specs for a network, only the light client's keep replaces that
  network's copy. The core's write of a newer copy there changes nothing.
- No write replaces a stored copy with an older one.
- Each rule is decided inside the write's own IndexedDB transaction, so two writers in two pages or a worker cannot
  interleave between the check and the write.
- A spec runs the reported case: the light client keeps copy 5 with its specs, the core then reads copy 6, and the
  light client's next start still opens 5.

What the owner meant: the stack is one set of data, so the device holds one copy of it. The fault is two writers with
no coordination, and the fix coordinates them, not gives each its own copy.

## Why this rule

The two writers accept a copy by different rules. The core needs a valid signature. The light client needs the engine
to accept the descriptor and every spec it names. A copy the light client accepted also passes the core's rule, since
the engine checks the signature too. The reverse fails, which is the bug. So where both write one copy, the stricter
writer's copy is the one kept. Light specs held for the network show that a light client writes on this device. On a
product's own origin no light client runs, so the core writes there as today.

## Placement

`packages/storage`, in the stack store (docs/code/placement.md § Inside a package: the rule is about the records, so it
sits with the writes). Files expected to change: `stackStore.ts`, `stackReader.ts` (JSDoc only, if any), their specs, and
the README's Design § Stack store.

## Interfaces and failures

- The reader factories, their exported types and the app callers do not change.
- The core's copy write becomes conditional: in one readwrite transaction over `stacks` and `light_specs`, it puts the
  copy only when the network holds no light specs and no newer copy. Its JSDoc says so. The core's `newer` still
  resolves with the copy, since the core starts from it on its own origin.
- The light client's keep, copy and specs in one transaction as before, skips both when a newer copy is stored, so its
  specs never land beside a copy they do not belong to.
- A failed transaction keeps both old records and is reported, as now.

## Accepted behaviour changes

- On the root origin the core starts from the copy the light client kept. A copy the core verified but the light client
  has not kept yet waits for the light client.
- Left open: on a device whose light client has never kept specs, a core that runs first can still store a copy the
  light client then opens. Nothing is held then, so an outage fails that first start either way. A publisher fault in
  that window still fails the light client's start until a newer copy arrives.

## Out of scope

- The landing page's full reset still deletes `dotli`, with the light client's copy and specs in it.
- Two light clients on one device writing specs alone for different copies.

## Open questions

- None. Slice 1 writes the failing spec and the coordinated writes. Slice 2, if needed, updates the README.
