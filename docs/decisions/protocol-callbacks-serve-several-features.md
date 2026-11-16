# An external protocol's callbacks serve several features

The code answers an external protocol through a set of callbacks, and each callback serves a different feature. The
adapters that turn a callback into a feature's own calls could sit with each feature or together, and the imports
between them could run either way.

## How to resolve

1. Put the protocol's side whole in one feature folder, with its connection and every adapter. The assembly of the
   callbacks and the composition root that starts them sit there too.
2. That folder imports the features it serves through their `index.ts`.
3. The served features expose plain actions and stores. No callback signature or wire format reaches them.
4. A served feature reaches the protocol folder only through its types, or through a facade passed in as a parameter,
   so the imports at runtime run one way.
5. Infrastructure in that folder that other features also read, such as a connection pool, is not the protocol's. It
   moves out ([an import cycle between folders](import-cycle-between-folders.md)).

The owner chose this without stating a reason. It keeps the protocol's wire format in one place.

## Example

```text
src/features/
  protocol/                 the protocol's side, whole
    connection.ts
    signAdapter.ts          turns a wire request into a plain call
    storageAdapter.ts
    callbacks.ts            assembles the callback object
    runtime.ts              the composition root
  signing/
    index.ts                plain actions and stores, no wire types
  storage/
    index.ts
```

```ts
// protocol/signAdapter.ts: the only place that knows the wire format
import { requestSignature } from '../signing/index.js';

export const onSignRequest = (message: WireSignRequest): Promise<WireSignResponse> =>
  requestSignature(toPayload(message)).then(toWireResponse);
```

```ts
// signing/requestSignature.ts: knows nothing of the protocol
export async function requestSignature(payload: SignPayload): Promise<Signature> {}
```

## Not when

The infrastructure is shared beyond the protocol's callbacks. It gets its own folder instead.

## Cases

- The host's TrUAPI side became one feature that holds the core connection, every callback adapter and the composition
  root. (PR #479)

Status: active
