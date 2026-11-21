# A table column left with one reader

A developer removes a view that read one column of a feature's facts table. Such a table holds several facts for each
member. A state's label, description and colour are one example. After the removal, the developer looks for other
readers of that column and finds one, in a sibling feature, that reads the value of a single member, such as one state's
description in an announcement. Nothing else reads the column. The question is where that one value should live. The
column could stay in the table for every member. The table's feature could export that one value by name. The remaining
reader could hold the value itself.

## How to resolve

1. Remove the column from the table, for every member, with its type field.
2. Move the one value still read into the reader, as a constant beside the code that uses it.
3. Do not keep the column for the members nothing reads, and do not have the table's feature export that one value for
   the reader to import.

The owner chose that the remaining reader keeps its own value, without stating a further reason. Removing what the
removal left unread follows [branch-left-unreachable-by-a-removal](branch-left-unreachable-by-a-removal.md).

## Example

```ts
// Before: a panel listed every state's note, and a sibling's alert read one of them.
const SIGNAL = {
  calm: { label: 'Calm', note: 'All quiet', tone: 'green' },
  lost: { label: 'Lost', note: 'Signal lost. Retrying', tone: 'red' },
};
announce(SIGNAL.lost.note);
```

After the panel goes, the note column goes, and the alert holds its sentence:

```ts
const SIGNAL = {
  calm: { label: 'Calm', tone: 'green' },
  lost: { label: 'Lost', tone: 'red' },
};

// In the sibling feature, beside the alert.
const LOST_ANNOUNCEMENT = 'Signal lost. Retrying';
announce(LOST_ANNOUNCEMENT);
```

Not this:

```ts
// The table's feature keeps a named export for its one outside reader.
export const LOST_NOTE = 'Signal lost. Retrying';
```

## Cases

- The network panel's status line, which showed each health's sentence, was removed. The topbar's offline announcement
  read the sentence of one health from the same table and nothing else read the column. The owner chose that the topbar
  keeps its own sentence, over keeping the column for every health or exporting the one sentence from the network
  feature. (docs/_plans/network-head-dot-design.md, feat/network-chain-indicators)

Status: active
