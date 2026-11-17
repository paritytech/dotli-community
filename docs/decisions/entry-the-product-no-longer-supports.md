# An entry the product no longer supports

A developer drops support for one entry of a set of names an external protocol defines, such as a permission whose
capability cannot work where products run. Several pieces of logic walk the catalog built on those names: a menu,
presets and the scoring that reads them, the attributes built from it, and the protocol's answers. Removing the entry
piece by piece raises a fresh question in each one, such as how presets that now look alike should behave. The question
is how the entry is kept out of every piece of that logic at once.

## How to resolve

1. Keep one named list of the unsupported names, with a type of its members, in the module that owns the catalog's
   policy.
2. Derive the catalog's name type by excluding that type from the protocol's names, so every piece that walks the
   catalog loses the entry through the type. Leave each piece's own logic as it was, so it reads the remaining entries
   as before.
3. Where the protocol can still send the name, check it against the same list to answer it. Which answer it gets is in
   [permission-request-the-host-no-longer-offers](permission-request-the-host-no-longer-offers.md).
4. Do not hide the entry in each place that shows or scores it, and do not redesign a piece because the entry left it.

The owner's reason is that one list that excludes the unwanted entries from all of the logic is the simple way, and that
a piece such as the preset scoring should just ignore the entry and stay the same.

## Example

```ts
type UnsupportedFeature = 'Teleport';
const UNSUPPORTED_FEATURES: ReadonlySet<FeatureName> = new Set<UnsupportedFeature>(['Teleport']);

// Menu, presets and attributes all walk this type, so none of them sees the entry.
export type OfferedFeature = Exclude<FeatureName, UnsupportedFeature>;

export function isUnsupportedFeature(name: FeatureName): name is UnsupportedFeature {
  return UNSUPPORTED_FEATURES.has(name);
}
```

Not this:

```ts
const menuItems = features.filter((name) => name !== 'Teleport');
const presetScore = (statuses: Statuses) => scoreWithout(statuses, 'Teleport');
const frameAllow = directives.filter((directive) => directive !== 'teleport');
```

## Cases

- A device permission whose browser API cannot work in the product's frame was being removed. Removing it left two
  presets of the slider identical, and the agent asked how the slider should behave. The owner said to ignore the
  permission in the slider's reading so the slider stays the same, and to keep one list of unsupported permissions that
  excludes them from all of the logic. The list's type is excluded from the enforceable names, so the catalog, panel,
  presets and frame never see it, and the protocol answer checks the list to deny a request.
  (feat/browser-device-permissions, docs/_plans/nfc-removal-design.md)

Status: active
