# A generated codec misses a version the bundled core still serves

The host reads protocol messages with codecs a dependency generates. The codegen emits only the newest envelope version
of each method, while the core the host bundles still serves older versions and answers in the request's version. A
product built with an older SDK sends an older version, and the host fails to decode it. The package also exports the
per-version body codecs and a helper that builds an envelope with explicit discriminants. The question is which of
these to do:

- compose the missing versions in the host
- reshape every entry the same way
- wait for the package to publish codecs that cover every version

## How to resolve

1. Find the methods the bundled core serves at more than one version, among those the host reads.
2. For each of them only, compose the request and response envelope codecs in the host from the package's exported
   per-version codecs, one variant per version the core serves, with each version's own discriminant.
3. Keep the generated codec for every method served at one version. Do not reshape them to match.
4. Do not wait for an upstream codec, and do not downgrade an older-version message to an expected failure meanwhile.

The owner chose this without stating a reason. It fixes the reads that fail now with what the package already exports,
and leaves the entries that work untouched.

## Example

```ts
// Only the method served at two versions gets a composed envelope.
const placeOrderRequest = indexedTaggedUnion({
  V1: [0, OrderPayload],
  V2: [1, OrderPayload],
});
// The result wraps the envelopes: one for the ok value, one for the error.
const placeOrderResponse = Result(
  indexedTaggedUnion({ V1: [0, OrderReceipt], V2: [1, OrderReceipt] }),
  CallError(indexedTaggedUnion({ V1: [0, V1PlaceOrderError], V2: [1, PlaceOrderError] })),
);

export const methods = {
  placeOrder: { request: placeOrderRequest, response: placeOrderResponse },
  // Served at one version: the generated codecs stay.
  cancelOrder: { request: VersionedCancelOrderRequest, response: VersionedCancelOrderResponse },
};
```

Not this:

```ts
// Every entry rebuilt from per-version codecs, though only one needed it.
cancelOrder: { request: indexedTaggedUnion({ V1: [0, CancelPayload] }), response: /* ... */ },
```

## Cases

- The host's phone request tracker failed to decode a transaction request that products built with an older SDK sent at
  the older envelope version. Only that method's table entry was composed from the per-version codecs, the other entries
  kept the generated codecs, and no upstream codec was awaited. The table itself is temporary until the core reports
  these requests. (Sentry DOTLI-M6, docs/_plans/phone-request-versions-design.md)

Status: active
