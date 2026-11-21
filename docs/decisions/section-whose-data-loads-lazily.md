# A section whose data loads lazily

A developer builds a card or popover with a section whose data loads only after the card opens, such as details about
a related entity. The data is not there on first render, and hiding the section until it arrives looks like the tidy
choice. The question is what the section shows while it loads.

## How to resolve

1. Render the section from the start. Never hide it while its data loads.
2. Show a loader in the section's place while the data loads.
3. Replace the loader with the data once it arrives.

The owner chose a loader over a section that appears only once its data is found. The owner stated no further reason.

## Example

```tsx
function OwnerSection(props: { owner: Loadable<Owner> }) {
  return (
    <section data-testid="owner">
      <Show when={props.owner.ready} fallback={<Loader />}>
        <OwnerRow owner={props.owner.value} />
      </Show>
    </section>
  );
}
```

Not this:

```tsx
// The section is missing until its data arrives.
<Show when={props.owner.ready}>
  <section data-testid="owner">
    <OwnerRow owner={props.owner.value} />
  </section>
</Show>
```

## Cases

- A product card's author section, read when the card opens, was hidden while it loaded. It shows a loader instead.
  (docs/_plans/product-author-name-design.md, main)

Status: active
