# A moved helper reads what its new home already holds

A developer moves a helper into another feature with its only caller. The helper reads data from more than one source,
and for one of them it reads and caches the data itself, such as an archive it loads once per page. In the new feature
they notice that the feature already reads that same data into memory for its own work and holds it for as long as the
helper can be asked for it. The question is whether the helper moves whole, still reading and caching its own copy, or
is trimmed to what the new feature lacks.

## How to resolve

1. Move the helper into its caller's feature
   ([grouping source into folders](grouping-source-into-folders.md)).
2. Drop the helper's own read and cache of the data the feature already holds. The helper takes that data from the
   feature, which hands in what it holds.
3. Keep only the reads the feature does not already do. Pass in what they need, such as the fetch they call, rather than
   having the helper reach for it.

The owner chose the trimmed helper over moving it whole, without stating a further reason. In the case, the feature
held the data for as long as the helper could be asked for it, so the helper's own read and cache only kept a second
copy.

## Example

```ts
// Before: the helper loads and caches the bundle itself, once per page.
let bundle: Promise<Files> | undefined;
export function createAssetReader(name: string) {
  return async (ref: AssetRef) => {
    if (ref.kind === 'bundled') {
      bundle ??= loadBundle(name);
      return (await bundle).get(ref.path);
    }
    return fetchBlock(ref.id);
  };
}

// After: in the feature that already holds the bundle for its run.
export function createAssetReader(files: Files, fetchBlock: (id: string) => Promise<Bytes>) {
  return (ref: AssetRef) => (ref.kind === 'bundled' ? files.get(ref.path) : fetchBlock(ref.id));
}

// in the run, which loaded `files` to start and holds them until it ends
const readAsset = createAssetReader(files, fetchBlock);
```

## Cases

- Chat moved from the product frame to the product worker's run, and the chat image reader moved with its only caller
  into the product worker's feature. The run already reads the whole worker archive to start the worker and holds it
  for the run's life, as long as images can be asked for. The owner chose to drop the reader's own archive read and
  page-life cache, take archive images from the files the run holds, and keep only the single content block read, with
  the block fetch passed in. The owner chose this over moving the reader whole. (docs/_plans/worker-chat-design.md)

Status: active
