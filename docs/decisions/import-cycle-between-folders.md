# An import cycle between folders

Two folders import each other, directly or through others. A module reads an import at load time and finds it
undefined, and reordering the imports looks like the fix.

## How to resolve

1. Find what each side needs from the other. The cycle ends where that thing moves, never in the import order.
2. Shared infrastructure that several folders read moves down into its own folder, below everything that uses it. Any
   folder may import it.
3. A wrapper around something a folder already receives as a parameter comes in beside that parameter, not through an
   import.
4. A folder that mixes a part others read with a part that sits above them splits in two.
5. A metric or a log tag moves to the module that uses it.
6. When the cycle rests on one import of a small value or type, move that one file and stop there.

The owner's reason: fixing only the modules that read an import at load time leaves the cycle in place, and untangling
the structure ends it.

## Example

Shared infrastructure moves down into its own folder:

```text
Before                                  After
features/protocol/                      features/connections/   imported by any feature
  callbacks.ts   imports signing          pool.ts
  pool.ts                               features/protocol/
features/signing/                         callbacks.ts          imports signing
  sign.ts        imports protocol/pool  features/signing/
                                          sign.ts               imports connections
```

A wrapper comes in beside the parameter the feature already receives:

```ts
// Before: signing imports withRetry from protocol, which imports signing.
// After: the composition root passes it in.
export function createSigning({ lease, withRetry }: SigningDeps) {}
```

A cycle held by one small value ends by moving that value:

```ts
// Before: storage/metrics.ts declares SYNC_COUNT, sync/ imports it, and storage/ imports sync/.
// After: sync/syncRun.ts, which counts it, declares SYNC_COUNT itself.
```

## Cases

- Shared connection infrastructure moved out of the protocol feature into its own feature, and a debug folder split
  into a part others read and a part above them. (PR #479)
- In the two small apps with no user flows, each cycle ended by moving the one file that held it. (PR #479)

Status: active
