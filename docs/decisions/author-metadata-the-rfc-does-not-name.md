# Author metadata the product-manifest RFC does not name

A developer adds a piece of a product's author metadata that the product-manifest RFC's "Resolving a product" does not
name, such as a display name for the author's address. The parts the RFC names are read while the product resolves and
cached with the manifests. Other parts are read when the visitor first opens the author card and are not cached across
page loads. The new piece may come from the same contracts as a resolve-time read, so it could ride along with that
read. The question is when to read it and where to keep it.

## How to resolve

1. Leave the resolve-time reads to what the RFC names. Do not fold the new piece into one of them, even when it comes
   from the same contracts.
2. Read the new piece as its own read when the author card first opens, beside the card's other reads, after any read
   it depends on.
3. Keep it as the card's other reads are kept, not cached with the manifests across page loads.

The owner chose the card-open read over folding it into the resolve-time read and its cache. The owner stated no further
reason.

## Example

```ts
// Resolve time: only what the RFC names, cached with the manifests.
const owner = await readNameOwner(name);

// Card open: the extra parts, each its own read, not cached across page loads.
async function loadAuthorCard(owner: Address) {
  const [account, handle] = await Promise.all([readAccount(owner), readHandle(owner)]);
  const label = handle ?? (await readReverseName(owner));
  return { account, handle, label };
}
```

Not this:

```ts
// The extra part rides along with the resolve-time read and lands in the manifest cache.
const { owner, reverseName } = await readNameOwnerWithReverseName(name);
```

## Cases

- A forward-checked reverse-record display name for the name owner's address, read from the same contracts as the owner
  address and needed only when the username read finds nothing, is read when the card opens, after the owner address and
  beside the account and username reads, and is not cached across page loads.
  (docs/_plans/product-author-name-design.md, main)

Status: active
