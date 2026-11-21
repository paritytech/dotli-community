# A view shows a status the state layer already reports

A developer builds a view that shows each item's status, such as whether its connection is still coming up or is up.
The state layer already publishes a verdict per item that the view could read. Looking closer, the developer notices
the verdict also turns briefly to a waiting state in a case where the underlying thing may not have changed, such as
right after the page returns from being hidden. The question is whether the view reads the verdict as it is, or whether
the state layer gains a second fact, or a changed verdict, so the view never shows that brief state.

## How to resolve

1. Read the state layer's existing verdict in the view, and show whatever state it reports, the brief ones included.
2. Do not add a second per-item fact beside the verdict only to hide a brief state.
3. Do not change the verdict, or what other readers of it see, to suit this view.

The owner's reason: the view shows the real status, whatever state it is in, and a second fact or a reworked verdict to
smooth over a brief state is overengineering.

## Example

```tsx
function PeerRow(props: { peer: Peer }) {
  const use = useStore(props.peer.$use); // 'unused' | 'pending' | 'live'
  return <span data-state={use()}>{use() === 'live' ? 'Connected' : 'Connecting'}</span>;
}
```

Not this:

```ts
// A second fact beside the verdict, kept only so the row skips the brief
// 'pending' after the page comes back.
const $linkUp = computed([peer.$events], (events) => events.lastOpen > events.lastClose);
```

## Cases

- A network panel's chain rows needed a connecting or connected fact, and the chain state layer's use verdict also
  turns a chain pending for up to one event interval after the page returns from hidden. The owner chose to read the
  verdict as it is over a separate connection-is-up fact or a verdict that ignores page returns.
  (docs/_plans/chain-row-connection-design.md, feat/network-chain-indicators)

Status: active
