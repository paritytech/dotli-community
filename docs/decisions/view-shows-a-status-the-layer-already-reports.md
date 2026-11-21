# A view shows a status the state layer already reports

A developer builds a view that shows each item's status, such as whether its connection is still coming up or is up. The
state layer already publishes a verdict per item that the view could read, and other readers, such as a summary
indicator, read it too. Looking closer, the developer notices the verdict reports a waiting state the view would rather
not show. It may turn briefly to waiting where the underlying thing may not have changed, such as right after the page
returns from being hidden. Or it may call an item waiting while nothing on the page holds it, because a shared backend
brings it up anyway. The question is whether the view reads the verdict as it is, whether the state layer gains a second
fact for the view, or whether the verdict changes.

## How to resolve

1. Read the state layer's existing verdict in the view, and show whatever state it reports, the brief ones included.
2. Do not add a second per-item fact beside the verdict only so one view shows a different state.
3. Do not change the verdict, or what other readers of it see, to suit this view, unless a "Not when" below holds.

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
const $linkUp = computed([peer.$events], events => events.lastOpen > events.lastClose);
```

When nothing on the page holds the item, the verdict itself changes, so every reader sees it:

```ts
function judgeUse(peer: PeerState): PeerUse {
  if (peer.holders === 0) return 'unused'; // was: the backend's phase decided 'pending'
  return peer.phase === 'up' ? 'live' : 'pending';
}
```

## Not when

- The verdict calls an item waiting while nothing on the page holds it, only because a shared backend brings it up on
  its own. Then the waiting state misleads rather than reports, and step 3 does not hold. Change the verdict in the
  state layer so an item nothing holds is unused whatever the backend does, and let every reader, the summary included,
  show it so. It turns waiting once something takes it. Step 2 still holds: no second fact for the view alone. The
  owner's reason: unused is the less misleading default, and the waiting state belongs to the moment something starts
  using the item.

## Cases

- A network panel's chain rows needed a connecting or connected fact, and the chain state layer's use verdict also turns
  a chain pending for up to one event interval after the page returns from hidden. The owner chose to read the verdict
  as it is over a separate connection-is-up fact or a verdict that ignores page returns.
  (docs/_plans/chain-row-connection-design.md, feat/network-chain-indicators)
- The network monitor counted a chain nothing on the page held as pending while the frame's light client synced it, so
  its row and the topbar read connecting or syncing before turning not in use. The owner chose to make the monitor count
  an unheld chain as unused, topbar included, over a held-by-this-page fact for the row or no change.
  (docs/_plans/chain-row-unused-default-design.md, feat/network-chain-indicators)

Status: active
