# A branch left unreachable by a removal

A developer removes an entry from a table or catalog that drives a mechanism, such as a list of items whose facts pick
which code path runs. The removed entry was the last one to use one variant of a fact, so no entry reaches that variant
and the code paths it drives anymore. The code still compiles, and its unit tests reach it only through the real
table. The question is whether that variant goes with the entry or stays, as a capability or behind a test-only seam
that keeps it covered.

## How to resolve

1. Delete the variant from the fact's type, and every branch, notice and check it drives.
2. Delete the tests that drive those branches. Do not add a test-only entry or make the table injectable just to keep
   unreachable code covered.
3. Name the removed capability and why it goes in the commit or PR.

This is the case the cleanup rule in `AGENTS.md` asks the owner about, a working capability with no caller. Asked, the
owner chose to delete it with its tests, without stating a further reason.

## Example

```ts
// Before: one entry still used the 'byHost' variant.
type Consent = 'byBrowser' | 'byHost';
const catalog = { camera: { consent: 'byBrowser' }, scanner: { consent: 'byHost' } };

function onGrant(item: Item) {
  if (item.consent === 'byHost') {
    rebuildFrame();
  }
}
```

After the scanner entry goes, the variant and its branch go too:

```ts
const catalog = { camera: {} };
// No consent fact, no rebuildFrame on grant, and no spec for either.
```

Not this:

```ts
// Kept alive only for tests through an injected catalog.
function createGrantHandler(catalog: Catalog = defaultCatalog) {}
```

## Cases

- A device permission that cannot work in the product's frame left the permissions catalog. It was the last entry whose
  frame directive the host granted itself. That variant drove a reload notice in the dialog and a rebuild of the frame on
  grant, and it hid the one-time grant. The variant, those branches and their tests were deleted, rather than kept or kept
  reachable through an injectable catalog.
  (feat/browser-device-permissions, docs/_plans/nfc-removal-design.md)

Status: active
