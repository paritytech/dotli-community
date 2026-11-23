# What a removal leaves unreached

A developer removes something that other code was built around: an entry of a table or catalog that drives a
mechanism, or a view that read one column of a feature's facts table. Looking around after the removal, they find
something that nothing reaches or reads anymore, though the code still compiles:

- a variant of a fact that no remaining entry uses, with the branches, notices and tests it drives, which unit tests now
  reach only through the real table
- a column of a facts table whose one remaining reader, in a sibling feature, reads the value of a single member
- a choice the user is offered that now holds the same values as another, so reading the current choice back always
  lands on the other and the user can never select it

The question is whether what is left goes with the removal or stays. It could stay as a capability, or behind a
test-only seam that keeps it covered. A value could stay as a named export for its one reader, and a choice beside its
twin.

## How to resolve

1. After the removal, look for what it left with no entry, reader or path to it.
2. Delete a variant no entry uses from the fact's type, with every branch, notice and check it drives, and the tests
   that drive those branches. Do not add a test-only entry or make the table injectable just to keep unreachable code
   covered.
3. Remove a column nothing reads from the table, for every member, with its type field. When one reader still reads a
   single member's value, move that value into the reader, as a constant beside the code that uses it. Do not keep the
   column for the members nothing reads, and do not have the table's feature export that one value for the reader.
4. Drop a choice the user can no longer select. The choice that stays takes any cue the dropped one carried for those
   values, such as a warning. Do not change the other choice's values so the two differ again, and do not store which
   choice the user picked.
5. Name a removed capability and why it goes in the commit or PR.

A variant with no entry is the case the cleanup rule in `AGENTS.md` asks the owner about, a working capability with no
caller. Asked, the owner chose to delete it with its tests, without stating a further reason. The owner also chose that
the remaining reader keeps its own value, without stating a further reason. A choice the user cannot select is a defect,
so the piece that offers it loses that choice rather than staying as it was.

## Example

A catalog entry goes, and it was the last to use the `'byHost'` variant:

```ts
// Before
type Consent = 'byBrowser' | 'byHost';
const catalog = { camera: { consent: 'byBrowser' }, scanner: { consent: 'byHost' } };

function onGrant(item: Item) {
  if (item.consent === 'byHost') {
    rebuildFrame();
  }
}

// After: the variant and its branch go too, with no spec for either.
const catalog = { camera: {} };
```

A panel that listed every state's note goes, and a sibling's alert read one of the notes:

```ts
// Before
const SIGNAL = {
  calm: { label: 'Calm', note: 'All quiet', tone: 'green' },
  lost: { label: 'Lost', note: 'Signal lost. Retrying', tone: 'red' },
};
announce(SIGNAL.lost.note);

// After: the note column goes, and the alert holds its sentence.
const SIGNAL = {
  calm: { label: 'Calm', tone: 'green' },
  lost: { label: 'Lost', tone: 'red' },
};
const LOST_ANNOUNCEMENT = 'Signal lost. Retrying'; // in the sibling feature, beside the alert
announce(LOST_ANNOUNCEMENT);
```

An entry goes, and `wide` differed from `open` only by it, so a tie reads as `open` and `wide` can never be selected:

```ts
// Before
const levels = [closed, open, wide];
const warns = (level: Level) => level.id === 'wide';

// After: `wide` goes, and `open` carries its warning.
const levels = [closed, open];
const warns = (level: Level) => level.id === 'open';
```

Not this:

```ts
function createGrantHandler(catalog: Catalog = defaultCatalog) {} // kept alive only for tests
export const LOST_NOTE = 'Signal lost. Retrying'; // a named export for one outside reader
```

## Cases

- A device permission that cannot work in the product's frame left the permissions catalog. It was the last entry whose
  frame directive the host granted itself. That variant drove a reload notice in the dialog and a rebuild of the frame on
  grant, and it hid the one-time grant. The variant, those branches and their tests were deleted, rather than kept or kept
  reachable through an injectable catalog.
  (feat/browser-device-permissions, docs/_plans/nfc-removal-design.md)
- After that removal, the less safe of two now identical presets of the permissions slider could never be shown as
  current, since a tie reads as the safer one, so the user could not select it and its warning never showed. The owner
  called the unselectable preset wrong and chose to drop it, leaving three stops, with the safer preset taking its
  warning icon. (feat/browser-device-permissions, docs/_plans/unlimited-removal-design.md)
- The network panel's status line, which showed each health's sentence, was removed. The topbar's offline announcement
  read the sentence of one health from the same table and nothing else read the column. The owner chose that the topbar
  keeps its own sentence, over keeping the column for every health or exporting the one sentence from the network
  feature. (docs/_plans/network-head-dot-design.md, feat/network-chain-indicators)

Related: [entry-the-product-no-longer-supports](entry-the-product-no-longer-supports.md) keeps a dropped protocol entry
out of every piece of logic at once.

Status: active
