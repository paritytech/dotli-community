# Two kinds of module share a name

Two kinds of module that sat in separate folders now sit together, such as a view and the island that hydrates it. A
pair of them has the same file name and the same export. Some pairs clash today, and others could later.

## How to resolve

1. Pick the kind other code imports less often, and give it a marker, such as a suffix.
2. Give the marker to every module of that kind, those that clash and those that don't.
3. The other kind keeps its plain names.
4. A third module caught in the clash, such as one that binds the view to state, takes the name of its main export.

The owner chose this without stating a reason. One name shape per kind lets a reader tell the kind from the name alone,
and a later clash never forces a rename.

## Example

```text
features/account/
  AccountPanel.tsx            the view keeps its plain name
  AccountPanelIsland.tsx      export function AccountPanelIsland
  useAccountPanel.ts          the binding module, named after its main export
features/settings/
  SettingsMenuIsland.tsx      suffixed too, though no view shares its name today
```

```astro
<AccountPanelIsland client:load />
```

## Cases

- Every island took an `Island` suffix in its file name and its export, and views kept their names. (PR #479)

Status: active
