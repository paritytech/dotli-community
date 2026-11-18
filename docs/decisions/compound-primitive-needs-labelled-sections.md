# A compound primitive needs labelled sections

A shared primitive that knows no domain is a compound component, a root plus a part per item, and it renders its items
as one flat list. A caller needs one popup or list with several kinds of items, each under a visible heading, while
keyboard order still runs through all of them. The caller already owns the items and which one is active. The question
is whether the sections come from a new part the caller composes, from a section key on each item that the root groups
by, or from the root taking section data and rendering the items itself.

## How to resolve

1. Add a new compound part for a section, which takes its heading as a `label` and wraps the item parts the caller puts
   inside it.
2. Let the part render the accessible group for the pattern, labelled by its visible heading.
3. Leave the root as it is. It takes no section map and no item data, and keeps rendering its children.
4. Let the caller decide which sections to render, so it skips an empty section itself.

The owner chose this without stating a reason. It extends the compound API by one part, so the root and every caller
that needs no sections stay unchanged.

## Example

```tsx
// The caller composes sections from parts and skips an empty one.
<Menu.Root active={active()}>
  <Show when={drafts().length > 0}>
    <Menu.Group label="Drafts">
      <For each={drafts()}>{(d) => <Menu.Item id={d.id}>{d.title}</Menu.Item>}</For>
    </Menu.Group>
  </Show>
  <Menu.Group label="Templates">
    <For each={templates()}>{(t) => <Menu.Item id={t.id}>{t.name}</Menu.Item>}</For>
  </Menu.Group>
</Menu.Root>

// The part renders a group labelled by its heading.
<div role="group" aria-labelledby={headingId}>
  <div id={headingId}>{props.label}</div>
  {props.children}
</div>
```

Not this:

```tsx
<Menu.Item id={d.id} section="drafts" />          // a key per item
<Menu.Root sections={{ drafts: 'Drafts' }} />      // the root groups by it

<Menu.Root sections={[{ label: 'Drafts', items }]} /> // the root renders from data
```

## Cases

- A landing page redesign needed one shared listbox popup with two kinds of entries under visible headings. The listbox
  gained a group part with a label, and the root stayed as it was. (issue paritytech/dotli-community#92, design
  `docs/_plans/landing-horizon-design.md`)

Status: active
