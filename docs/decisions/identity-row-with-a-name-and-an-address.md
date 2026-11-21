# An identity row with a name and an address

A developer builds a row that shows an account or another entity. The entity always has a raw address and may also have
a human-readable name. Showing both, the name over a shortened address, looks like it gives the visitor more. The
question is whether the row shows both or one.

## How to resolve

1. Show only the name when the entity has one.
2. Show the shortened address only when there is no name.

The owner chose the name alone over the name with the address under it. The owner stated no further reason.

## Example

```tsx
function IdentityRow(props: { name: string | null; address: string }) {
  return <span data-testid="identity">{props.name ?? shortenAddress(props.address)}</span>;
}
```

Not this:

```tsx
// Both lines, the address under the name.
<>
  <span>{props.name}</span>
  <span>{shortenAddress(props.address)}</span>
</>
```

## Cases

- A product card's author row showed a verified name with the shortened address under it. It shows only the name when
  one is found, and the address otherwise. (docs/_plans/product-author-name-design.md, main)

Status: active
