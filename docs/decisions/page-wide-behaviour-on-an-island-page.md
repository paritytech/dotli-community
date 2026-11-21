# Page-wide behaviour on a page of islands

A developer adds a DOM behaviour to an Astro page that is static markup plus Solid islands. The behaviour belongs to no
single island: it spans the whole page, such as writing a `data-*` attribute or CSS custom properties on the page's root
element and adding document-level listeners. It must already run before the user can reach a control that one island
owns, such as the page's text field. The page has an entry module, referenced by a `<script>` in the page, that starts
error reporting and boot. The question is where the behaviour starts. It could start from the page's entry module. It
could start from the island that owns the control, when it settles, and stop on its cleanup. It could also start from an
Astro `<script>` in the page's own markup.

## How to resolve

1. Give the owning feature a starter, exported through the feature's public index.
2. Let the starter find the page elements it works on by their own `data-*` attributes and start the behaviour on them.
3. Call the starter from the page's entry module, beside the error reporting and boot it already starts.
4. Do not start it from the island that owns the control, and do not add a second `<script>` in the page's markup for it.

The owner chose the page's entry module without stating a reason beyond the options offered.

## Example

```ts
// features/catalog/startViewportSizing.ts
export function startViewportSizing(): void {
  const root = document.querySelector<HTMLElement>('[data-catalog-root]');
  if (!root) return;
  // writes data-* and custom properties on the root, adds document-level listeners
}

// features/catalog/index.ts
export { startViewportSizing } from './startViewportSizing.js';

// shell/main.ts, the page's entry module
startReporting();
startViewportSizing();
boot();
```

Not this:

```tsx
// started by the island that owns the search field, so the page-wide behaviour lives and dies with one island
export function SearchIsland() {
  onSettled(() => {
    const stop = startViewportSizing();
    onCleanup(stop);
  });
}
```

## Cases

- The landing page needed a viewport behaviour that writes a `data-*` attribute and CSS custom properties on the page
  root and listens at document level, running before the user can focus the name field, which one island owns. The
  owner chose to start it from the page's entry module through the landing feature's public index, with the starter
  finding its own page boxes by `data-*` attributes, over the island that owns the field and over an Astro `<script>`
  in the page's markup. (fix/landing-backdrop-lvh, docs/_plans/landing-viewport-design.md)

Status: active
