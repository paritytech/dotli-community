# A decorative graphic draws real entities beside simulated ones

A developer builds a decorative graphic that shows live entities the app really observes, such as the peers a client is
connected to, next to simulated filler that only makes the picture look full. The filler is linked by a visual rule, such
as each dot to its nearest neighbour. Applying the same rule to the real entities is easy, but it draws relations between
them that the data does not hold. The question is how the graphic may link the real entities.

## How to resolve

1. For each real entity, draw only the relations the data holds, such as each peer to the client it is connected to.
2. Never link two real entities by a visual rule, such as nearest neighbour, when the data holds no relation between
   them.
3. Keep invented links to the simulated elements, and draw them so they read as filler, such as dimmer than the real
   links.

The owner's reason: a link from one real entity to another tells the viewer they are related, so drawing one the data
does not hold fakes a relation between them.

## Example

```text
not: every dot links to its nearest neighbour on the next inner ring

  client <- peerA <- peerB        peerB shown as connected through peerA
             ^
          filler1 <- filler2

instead: real entities link to what they are really connected to

  client <- peerA
  client <- peerB                 each peer links straight to the client
  filler1 <- filler2              only filler links by the visual rule, dimmer
```

## Cases

- The landing page's orbit placed the client's real network peers on rings among simulated dots, and the first build
  linked every dot to its nearest neighbour on the next inner ring. The owner said real peers must link from the centre,
  since the nearest-neighbour links faked relations between peers. Each peer and the server now link straight to the
  centre, and only simulated dots link inward to each other, dimmer. (branch `feat/landing-orbit-peers`,
  `docs/_plans/landing-orbit-peers-design.md` § Changes after the first review)

Status: active
