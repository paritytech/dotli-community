# A decorative graphic draws real entities beside simulated ones

A developer builds a decorative graphic that shows live entities the app really observes, such as the peers a client is
connected to, next to simulated filler that only makes the picture look full. Several shortcuts are easy here:

- Linking the real entities by the filler's visual rule, such as each dot to its nearest neighbour, draws relations the
  data does not hold.
- Laying out fixed filler slots and turning a filler element into the real entity when one arrives makes one element
  mean simulated, then real.
- Drawing the filler and its links from the start shows connections while nothing is really connected.

The question is how the graphic may show the real entities, how they come into view and how the filler relates to them.

## How to resolve

1. Make each real entity its own element. It appears only once the entity really exists, such as when the peer
   connects. Never turn a simulated element into a real one.
2. For each real entity, draw only the relations the data holds, such as each peer to the client it is connected to.
3. Never link two real entities by a visual rule, such as nearest neighbour, when the data holds no relation between
   them.
4. Derive the filler from the real entities' positions, so it spreads outward from each real entity. While no real
   entity exists, draw no filler links.
5. Keep invented links to the simulated elements, and draw them so they read as filler, such as dimmer than the real
   links.

The owner's reason: the graphic must not fake what the data does not hold. A link from one real entity to another tells
the viewer they are related, a simulated element that turns real blurs which elements are real, and filler links drawn
before anything is connected show connections that do not exist. Filler that grows out of the real entities keeps the
picture full while it still follows them.

## Example

```text
not: fixed filler slots, a slot's filler turns real, filler links from the start

  slot1 (filler -> peerA)  <- slot2 (filler)    links shown before any peer connects
  client <- peerA <- peerB                      peerB shown as connected through peerA

instead: real entities are their own elements, filler grows from them

  client                                        nothing connected: no filler links
  client <- peerA                               peerA appears when it connects
  peerA  <- filler1 <- filler2                  filler placed outward from peerA, dimmer
  client <- peerB                               each peer links straight to the client
```

## Cases

- The landing page's orbit placed the client's real network peers on rings among simulated dots, and the first build
  linked every dot to its nearest neighbour on the next inner ring. The owner said real peers must link from the centre,
  since the nearest-neighbour links faked relations between peers. Each peer and the server now link straight to the
  centre, and only simulated dots link inward to each other, dimmer. (branch `feat/landing-orbit-peers`,
  `docs/_plans/landing-orbit-peers-design.md` § Changes after the first review)
- The same orbit filled fixed slots with simulated dots, switched a slot's dot to a real peer when one joined and drew
  simulated links from the start. The owner said to draw no simulated connections until real ones exist, to make real
  peers appear only once they are really connected instead of reusing simulated dots, and to derive the simulated dots
  from the real ones' positions so they spread out from them. (branch `feat/landing-orbit-peers`,
  `docs/_plans/landing-orbit-peers-design.md` § Changes after the first review)

Status: active
