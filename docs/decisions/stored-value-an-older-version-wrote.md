# A stored value an older version wrote

A page reads a store that it does not migrate, such as one another component owns. An older version wrote a value there
that the current UI no longer offers, and for some items that old value now means one of the values the UI does offer.
Several readers consume the page's own values, and one adapter module maps the store's values to them. The question is
where the old value is folded into what it now means: once in the adapter, or in each reader through a shared helper.

## How to resolve

1. Fold the old value in the adapter, while it maps the store's value to the page's own type, item by item.
2. Hand the readers only values the current UI offers, so no reader knows the old value exists.
3. Add no helper that each reader must call to fold the value.

The owner chose to fold the value once, at read, without stating a further reason.

## Example

```ts
// The adapter folds while it maps, so readers see only current values.
function fromStoredStatus(item: Item, stored: StoredStatus): Status {
  if (stored === 'granted' && !item.offersGranted) {
    return 'unset';
  }
  return statusByStored[stored];
}
```

Not this:

```ts
// The adapter maps one to one and every reader must remember to fold.
const effective = effectiveStatus(item, status);
```

## Cases

- A remote store held a three-valued permission status that the core owns and the page does not migrate. For one class
  of permissions the UI offers only two of the values, and an old allowed now means open. The adapter folds it
  while reading, before any of its four readers sees it.
  (feat/browser-device-permissions, docs/_plans/browser-device-permissions-design.md)

Status: active
