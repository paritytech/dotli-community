# A permission request the host no longer offers

A developer removes a permission from the host's permissions UI, its panel, presets and dialog, because the capability
behind it cannot work in the environment the product runs in. Products can still request that permission through the
protocol. The host answers other requests it does not serve with a rejection, which the core does not store, while a
denial answer is stored for good. The question is which answer the host gives the request that no UI offers anymore.

## How to resolve

1. Keep the request in the protocol. Do not drop it or leave it unanswered.
2. Answer it with the protocol's denial, so the core stores it, not with the rejection other unserved requests get.
3. Do not grant it on the ground that the capability cannot be reached anyway.

The owner chose the denial without stating a reason. How the permission leaves the UI and reaches this answer through one
list is in [entry-the-product-no-longer-supports](entry-the-product-no-longer-supports.md).

## Example

```ts
// The capability cannot run where products run, so its request is denied, and the core keeps the denial.
function answerPermission(request: PermissionRequest): PermissionAnswer {
  if (unavailableHere.has(request.kind)) {
    return { kind: 'deny' };
  }
  return answerByRule(request);
}
```

Not this:

```ts
// Rejected like other unserved requests, so the core stores nothing.
if (unavailableHere.has(request.kind)) {
  throw new UnsupportedRequestError(request.kind);
}
```

## Cases

- A device permission whose browser API cannot run inside the product's frame was removed from the permissions UI. A
  product's request for it is answered with Deny, not rejected like other unserved requests, and not granted.
  (feat/browser-device-permissions, docs/_plans/nfc-removal-design.md)

Status: active
