# A list row opens a detail beneath it

A developer builds a list where a press on a row opens extra content under that row and a second press closes it, each
row on its own. The row's header is richer than a line of text, such as a mark, a name, a status line and a chevron. The
shared UI package has a disclosure primitive, but its header takes only a plain string. The question is whether to
extend that primitive so its header can be any element, to write the native disclosure element in the row itself, or to
build the row from plain parts.

## How to resolve

1. Lay the list out in the shared list container the package already has, in its list layout.
2. Make each row's header a plain button that carries `aria-expanded` and holds the rich header content.
3. Keep the open state in a local signal in the row, and render the detail under the button only while it is open.
4. Do not extend the shared disclosure primitive to take an element as its header, and do not write the native
   disclosure element in the row instead.

The owner's reason: a list of rows that expand is the shared list container with plain buttons inside, and nothing more
elaborate is needed. Keep it simple.

## Example

```tsx
// The list is the shared container, each row a plain button with its own open state.
<Panel layout="list">
  <For each={servers()}>{(server) => <ServerRow server={server} />}</For>
</Panel>

const ServerRow = (props: { server: Server }) => {
  const [open, setOpen] = createSignal(false);
  return (
    <div>
      <button type="button" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <StatusMark state={props.server.state} />
        <span>{props.server.name}</span>
        <span>{props.server.statusLine}</span>
        <ChevronDownIcon />
      </button>
      <Show when={open()}>
        <ServerHistory server={props.server} />
      </Show>
    </div>
  );
};
```

Not this:

```tsx
<Disclosure title={<ServerHeader server={server} />}>…</Disclosure> // the shared primitive widened for one screen
<details><summary><ServerHeader server={server} /></summary>…</details> // the native element written in the row
```

## Not when

The caller cannot replace the shared component with plain parts, because it needs the component's own behaviour, such
as a drawer's close button and drag to close. Then widen the component's string prop to take any element, as
[shared-component-text-prop-needs-rich-content](shared-component-text-prop-needs-rich-content.md) says.

## Cases

- A network popover lists each chain as a row with a mark, a name, a status line and a chevron, and a press opens the
  chain's block history under it. The shared accordion takes only a string title. The list became the shared well in
  its list layout, each row a plain button that toggles its detail from a local signal.
  (docs/\_plans/network-chain-indicators-design.md, network popover chain indicators change)

Status: active
