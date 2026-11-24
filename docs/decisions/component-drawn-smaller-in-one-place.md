# A component is drawn smaller in one place

A developer builds a view in a feature that shows one of the feature's own components, such as a round avatar that
shows an image or a letter on a fill when the image is missing. The component has one fixed size in its CSS module, and
its other users, such as list rows, keep that size. The new view, such as a head row, needs it smaller. The quick way is
a `class` prop, so the view's own CSS module sets a smaller width and height. That reaches only the outer box, not the
parts inside sized to it, such as the fallback letter's font. The question is whether the component takes a `size` prop
or a caller's `class`.

## How to resolve

1. Give the component a `size` prop with a named value for each size. Leaving it out keeps the standard size, so the
   other users do not change.
2. Style every size in the component's own CSS module, keyed by the prop, and scale each part inside that the size
   touches, such as the fallback letter.
3. Take no `class` from the caller to set the component's width and height.

The owner chose the `size` prop without stating a reason beyond the option as offered: the component's own module sets
each size, so the parts inside shrink with it, which a caller's module cannot reach.

## Example

```tsx
// The head row picks a size, and the component's module draws it.
<Monogram name={room.name} image={room.image} size="sm" />
<Monogram name={room.name} image={room.image} /> // list rows keep the standard size
```

```tsx
// Inside, the prop lands as a data attribute the component's module reads.
<span class={s['monogram']} data-size={props.size ?? 'md'}>
  <Show when={props.image} fallback={<span class={s['letter']}>{props.name[0]}</span>}>
    {(src) => <img class={s['image']} src={src()} alt="" />}
  </Show>
</span>
```

```css
.monogram {
  width: 40px;
  height: 40px;
}
.monogram[data-size='sm'] {
  width: 24px;
  height: 24px;
}
.monogram[data-size='sm'] .letter {
  font-size: 12px;
}
```

Not this, where the head's module sizes the box and the letter keeps the standard font:

```tsx
<Monogram name={room.name} class={s['head-monogram']} />
```

## Cases

- A chat head row in the drawer's title needed the room's avatar smaller than the room list's. An earlier change had
  removed the avatar's small size once nothing used it. Offered a `size` prop styled by the avatar's module or a
  `class` the head's module sizes, the owner chose the `size` prop. (docs/\_plans/chat-head-in-drawer-design.md,
  feat/chat-figma-design)

Related: [decoration-joins-a-presentational-component](decoration-joins-a-presentational-component.md), where a
caller's `class` sizes a piece's wrapper and the inner graphic fills it.

Status: active
