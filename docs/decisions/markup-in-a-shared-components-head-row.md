# A consumer's markup in a shared component's head row

A developer passes its own markup into a shared component's head row, such as a back button, a small picture and a name
as a drawer's title beside its standard close button. The row is as tall as its title line and its small control. The
consumer's parts come at their usual sizes, such as a default-size icon button taller than the close button or a
picture sized for a head of its own, so the row grows. As the consumer's state switches between plain text and its
markup, the head jumps. The question is how large the consumer's markup may be, and whether the head may grow to fit it.

## How to resolve

1. Take the head's height with its plain text title as fixed. The consumer's markup fits inside it in every state.
2. Give a control in the markup the same small size as the head's own control, such as the close button's.
3. Draw a picture compact, no taller than that control, at every screen width, through the component's own size, as
   [component-drawn-smaller-in-one-place](component-drawn-smaller-in-one-place.md) says.
4. Switch the consumer between its states in a browser and check the head keeps its height.

The owner's reason: markup in a head must never shift the layout, so it stays compact enough not to raise the head's
height.

## Example

```tsx
// Each part matches the close button's small size, so the head keeps its text height.
<Panel
  title={
    topic() ? (
      <>
        <IconButton size="sm" label="Back" onClick={leave} />
        <Badge of={topic()} size="sm" /> {/* 24px, no taller than the close button */}
        {topic().name}
      </>
    ) : (
      'Topics'
    )
  }
/>
```

Not this, where the default-size button and a full-size picture make the head taller only while a topic shows:

```tsx
<Panel title={<><IconButton label="Back" onClick={leave} /><Badge of={topic()} />{topic().name}</>} />
```

## Cases

- A chat drawer's head took a back button at the default icon-button size and a room avatar sized for its own head, so
  the head grew when a room opened. The owner rejected the shift: the back button took the close button's small size and
  the avatar's small size became 24 px at every width. (docs/\_plans/chat-head-in-drawer-design.md,
  feat/chat-figma-design)

Related: [shared-component-text-prop-needs-rich-content](shared-component-text-prop-needs-rich-content.md), which lets
the consumer pass the markup.

Status: active
