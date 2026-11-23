# An entry the product no longer supports

A developer drops support for one entry of a set of names an external protocol defines, such as a permission whose
capability cannot work where products run. Several pieces of logic walk the catalog built on those names: a menu,
presets and the scoring that reads them, the attributes built from it, and the protocol's answers. Removing the entry
piece by piece raises a fresh question in each one, such as how presets that now look alike should behave. Products can
still send the name through the protocol, and the host answers other requests it does not serve with a rejection, which
the core does not store, while a denial answer is stored for good. The question is how the entry is kept out of every
piece of that logic at once, and which answer the protocol gets when it still sends the name.

## How to resolve

1. Keep one named list of the unsupported names, with a type of its members, in the module that owns the catalog's
   policy.
2. Derive the catalog's name type by excluding that type from the protocol's names, so every piece that walks the
   catalog loses the entry through the type. Leave each piece's own logic as it was, so it reads the remaining entries
   as before.
3. Do not hide the entry in each place that shows or scores it.
4. Keep the name in the protocol. Where the protocol can still send it, check it against the same list and answer with
   the protocol's denial, so the core stores it. Do not drop the request or leave it unanswered. Do not reject it like
   other unserved requests, and do not grant it on the ground that the capability cannot be reached anyway.
5. Check that every choice a piece offers can still be reached, as
   [what-a-removal-leaves-unreached](what-a-removal-leaves-unreached.md) says.

The owner's reason is that one list that excludes the unwanted entries from all of the logic is the simple way, and that
a piece's logic, such as the preset scoring, should just ignore the entry. The owner chose the denial without stating a
reason.

## Example

```ts
type UnsupportedFeature = 'Teleport';
const UNSUPPORTED_FEATURES: ReadonlySet<FeatureName> = new Set<UnsupportedFeature>(['Teleport']);

// Menu, presets and attributes all walk this type, so none of them sees the entry.
export type OfferedFeature = Exclude<FeatureName, UnsupportedFeature>;

export function isUnsupportedFeature(name: FeatureName): name is UnsupportedFeature {
  return UNSUPPORTED_FEATURES.has(name);
}

// The protocol's request for it is denied, and the core keeps the denial.
function answerFeature(request: FeatureRequest): FeatureAnswer {
  if (isUnsupportedFeature(request.kind)) return { kind: 'deny' };
  return answerByRule(request);
}
```

Not this:

```ts
const menuItems = features.filter((name) => name !== 'Teleport');
const presetScore = (statuses: Statuses) => scoreWithout(statuses, 'Teleport');
const frameAllow = directives.filter((directive) => directive !== 'teleport');

// Rejected like other unserved requests, so the core stores nothing.
if (request.kind === 'Teleport') throw new UnsupportedRequestError(request.kind);
```

## Cases

- A device permission whose browser API cannot work in the product's frame was being removed. Removing it left two
  presets of the slider identical, and the agent asked how the slider should behave. The owner said to ignore the
  permission in the slider's reading, and to keep one list of unsupported permissions that excludes them from all of the
  logic. The list's type is excluded from the enforceable names, so the catalog, panel, presets and frame never see it.
  (feat/browser-device-permissions, docs/_plans/nfc-removal-design.md)
- In the same removal, a product's request for that permission is answered with Deny, not rejected like other unserved
  requests, and not granted. (feat/browser-device-permissions, docs/_plans/nfc-removal-design.md)

Status: active
