// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which dots the landing page's orbit draws. CSS places and turns them, so a dot is only its ring, its angle at rest
// and where its one link starts. What the visitor's centre really reaches the network through, its peers or one
// trusted provider, is spread evenly around the whole circle, whatever ring each node takes, and each is turned off its even
// place at random. Each node that joins takes a place between the ones already shown, so the first few stay spread
// round the circle however many follow. Each of those grows a simulated tree outward, like the peers of that peer.
// A tree's shape is fixed relative to its real node: where each of its dots sits from the real node, and which dot it
// links to, come from the seed and the real node alone, never from how many real nodes there are. Neighbouring trees
// only prune each other where they meet, so a real node that stays carries its tree along unchanged while others come
// and go. A light client's trees fill the circle between them, so the picture reads as the network going on behind the
// real connections. The trusted provider's one tree stays a narrow fan, and loose dots linked to nothing fill the rings
// around it, so a trusted provider backend's floor looks full but reads as one connection, not a network of its own.
// Every turn is drawn from a seed and the dot's key, so for one seed a dot keeps its turn while others come and go,
// and another seed lays out another picture.

type OrbitRing = 'inner' | 'ring1' | 'ring2' | 'ring3' | 'ring4';

/**
 * A peer of the light client, the one trusted provider a backend with no light client talks through, a simulated node of a real
 * node's tree, or a loose simulated dot linked to nothing.
 */
type OrbitDotKind = 'peer' | 'trustedProvider' | 'simulated' | 'loose';

export type OrbitDot = {
  /** Stays the same while the dot exists, so a renderer keeps its element. A dot never changes kind. */
  readonly key: string;
  /**
   * Its angle at rest, in degrees. Not wrapped to one turn, so the angle of a dot that stays moves by a little when
   * the real nodes change, never by a turn.
   */
  readonly start: number;
  /**
   * The angle at rest its one link starts from: the dot it grew from, on the ring one in, for a simulated dot, or the
   * centre, at 0, for a peer or the trusted provider. Null for a loose dot, which has no link.
   */
  readonly from: number | null;
  readonly kind: OrbitDotKind;
  /** The caption beside a peer, naming it by its join order, or beside the trusted provider. A simulated or loose dot has none. */
  readonly label: string | null;
};

export type OrbitLayout = {
  /**
   * From the centre outward, each with its radius in the orbit's length unit, which the renderer scales. Each ring lists
   * its real nodes first, in join order, and the real nodes fill the rings from the centre, so the real nodes read ring
   * after ring come in join order.
   */
  readonly rings: readonly { readonly ring: OrbitRing; readonly radius: number; readonly dots: readonly OrbitDot[] }[];
};

/** What the centre reaches the network through: the light client's peers, or one trusted provider. */
export type OrbitMode = { readonly kind: 'lightClient'; readonly peers: number } | { readonly kind: 'trustedProvider' };

/** A dot with the index of the ring it sits on, counted from the centre. */
type Node = { readonly index: number; readonly dot: OrbitDot };

/**
 * A place of a real node's tree: the ring it sits on, its key, its angle from the real node, and the key of the place
 * it links to on the ring inside, or of the real node itself on the first ring out.
 */
type Place = { readonly index: number; readonly key: string; readonly offset: number; readonly parent: string };

/**
 * The rings from the centre outward, each with its radius in the orbit's length unit, which `MIN_GAP` is in too, and
 * for each mode how many simulated nodes it holds and the loose dots it spreads round the whole circle. A light client's
 * ring holds its simulated nodes round the whole circle and the trusted provider's across its one fan, each node one
 * stride from the next, so the budget sets the stride. A light client's ring holds twice the one inside it, so its
 * trees branch ring by ring. The trusted provider's tree stays small, and its loose dots and tree together never
 * outnumber the light client's simulated nodes, so either field stays light enough to sit behind the page.
 */
const RINGS: readonly {
  readonly ring: OrbitRing;
  readonly radius: number;
  readonly budget: Record<OrbitMode['kind'], number>;
  readonly loose: Record<OrbitMode['kind'], number>;
}[] = [
  {
    ring: 'inner',
    radius: 110,
    budget: { lightClient: 0, trustedProvider: 0 },
    loose: { lightClient: 0, trustedProvider: 5 },
  },
  {
    ring: 'ring1',
    radius: 190,
    budget: { lightClient: 8, trustedProvider: 2 },
    loose: { lightClient: 0, trustedProvider: 10 },
  },
  {
    ring: 'ring2',
    radius: 260,
    budget: { lightClient: 16, trustedProvider: 4 },
    loose: { lightClient: 0, trustedProvider: 16 },
  },
  {
    ring: 'ring3',
    radius: 340,
    budget: { lightClient: 32, trustedProvider: 6 },
    loose: { lightClient: 0, trustedProvider: 24 },
  },
  {
    ring: 'ring4',
    radius: 430,
    budget: { lightClient: 64, trustedProvider: 8 },
    loose: { lightClient: 0, trustedProvider: 36 },
  },
];

/** The ring each real node takes in join order: ring `k` from the centre holds `3 * (k + 1)`, filled from the centre. */
const REAL_RINGS = RINGS.flatMap((_, index) => Array.from({ length: 3 * (index + 1) }, () => index));

/** The first real node's even place, in degrees, on the far side of the floor. */
const OFFSET = 282;

/**
 * How far a dot turns at most either way off its even place, among the real nodes, among its tree's places on its ring
 * or among a ring's loose places, as a share of the spacing between those places. Under half, so two neighbours never
 * meet or swap. A tree also takes this share of the real nodes' spacing more of a ring, for each ring it grew out, from
 * a neighbour whose tree grew out less.
 */
const JITTER = 0.3;

/**
 * For each mode, how far, in degrees, a tree reaches further either way on each ring out, which is also the most a node
 * of it sits from the node it grew from. The same for any count of real nodes, so a tree keeps its shape as they come
 * and go. The trusted provider's is small, so its tree grows out in one narrow fan.
 */
const REACH = { lightClient: 30, trustedProvider: 8 } satisfies Record<OrbitMode['kind'], number>;

/** The least distance along its ring between a simulated node and another node on that ring. */
const MIN_GAP = 10;

/**
 * Returns the orbit's dots for `mode`, every turn drawn from `seed`. The `count` real nodes take the places
 * `360 / count * k` past the first's, each turned by at most `JITTER` of that spacing. A node that joins takes a place
 * between two neighbours, and the others keep their order round the circle and close up by little. Peers take rings from
 * the centre outward in join order, and each peer's and the trusted provider's link starts at the centre.
 *
 * Each real node grows a tree of simulated nodes outward to the last ring, its link starting at the node it grew from.
 * The tree's places sit at fixed angles from its real node and link to fixed parents, which only the seed and the real
 * node's key and ring choose: on each ring out, one stride apart either way from the real node, each turned by at most
 * `JITTER` of the stride, as far as the tree's reach of `REACH` per ring out. A place links to the nearest of its tree's
 * places on the ring inside within `REACH` of it, preferring those no further from the real node than itself, and is
 * not part of the tree when there is none. A tree so fans wider the further out, and a real node that stays keeps its
 * tree's shape however the others change.
 *
 * A place shows only while its parent shows and it lies in its tree's part of the ring. Two trees split a ring where
 * the gap to each real node, less `JITTER` of the real nodes' spacing for each ring its tree grew out, is even, so a
 * deeper tree takes more of it, and a real node on the ring itself reaches no further than itself. The trees place
 * their dots ring by ring in their real nodes' join order.
 *
 * The trusted provider's rings then spread loose dots, with no link, over even places round the whole circle from a turn of the
 * seed's, each turned by at most `JITTER` of their spacing. A place within a tree's reach on its ring, and one reach
 * more so the tree stands apart, is left empty.
 *
 * A simulated or loose dot less than `MIN_GAP` along its ring from a dot placed before it is left out, and so are the
 * places of its tree that grow from it.
 */
export function getOrbitLayout(mode: OrbitMode, seed: number): OrbitLayout {
  const real = getRealNodes(mode);
  const spacing = 360 / real.length;
  const reach = REACH[mode.kind];
  const turn = spacing * JITTER;
  const roots = real.map(({ index, key, kind }, order): Node => {
    const start = getTurned(OFFSET + getEvenPlace(order, real.length) * spacing, turn, getUnitHash(seed, key));
    return { index, dot: { key, start, from: 0, kind, label: key } };
  });
  const trees = roots.map(root => ({ root, places: getTreePlaces(mode, seed, root) }));
  const nodes = [...roots];
  const shown = new Map(roots.map(root => [root.dot.key, root]));
  for (const [index, { ring, radius, loose }] of RINGS.entries()) {
    const clearance = (MIN_GAP / radius) * (180 / Math.PI);
    for (const { root, places } of trees) {
      for (const { key, offset, parent } of places.filter(place => place.index === index)) {
        const from = shown.get(parent);
        const start = root.dot.start + offset;
        // A tree leads by the most a real node turns for each ring it grew out, not by its reach, which can pass the
        // real nodes' spacing and would let a deeper tree take a neighbour's whole part.
        const own = getAngleGap(root.dot.start, start) - (index - root.index) * turn;
        const claimed = roots.some(
          other =>
            other !== root &&
            other.index <= index &&
            getAngleGap(other.dot.start, start) - (index - other.index) * turn < own,
        );
        if (
          !from ||
          claimed ||
          nodes.some(other => other.index === index && getAngleGap(other.dot.start, start) < clearance)
        ) {
          continue;
        }
        const node: Node = { index, dot: { key, start, from: from.dot.start, kind: 'simulated', label: null } };
        nodes.push(node);
        shown.set(key, node);
      }
    }
    const stride = 360 / loose[mode.kind];
    const phase = getUnitHash(seed, ring) * stride;
    for (let place = 0; place < loose[mode.kind]; place += 1) {
      const key = `${ring}.loose.${String(place)}`;
      const start = getTurned(phase + stride * place, stride * JITTER, getUnitHash(seed, key));
      const treed = roots.some(
        root => root.index <= index && getAngleGap(root.dot.start, start) < (index - root.index + 1) * reach,
      );
      if (treed || nodes.some(other => other.index === index && getAngleGap(other.dot.start, start) < clearance)) {
        continue;
      }
      nodes.push({ index, dot: { key, start, from: null, kind: 'loose', label: null } });
    }
  }
  return {
    rings: RINGS.map(({ ring, radius }, index) => ({
      ring,
      radius,
      dots: nodes.filter(node => node.index === index).map(({ dot }) => dot),
    })),
  };
}

/** Returns the real nodes `mode` shows in join order, each with its ring and its key, which is also its caption. */
function getRealNodes(mode: OrbitMode): { index: number; key: string; kind: 'peer' | 'trustedProvider' }[] {
  switch (mode.kind) {
    case 'lightClient':
      return REAL_RINGS.slice(0, mode.peers).map((index, peer) => ({
        index,
        key: `[peer#${String(peer + 1)}]`,
        kind: 'peer',
      }));
    case 'trustedProvider':
      return [{ index: 0, key: '[trusted provider]', kind: 'trustedProvider' }];
  }
}

/**
 * Returns the places of the tree that `root` grows in `mode`, ring by ring outward, each ring's in order round the
 * circle. They depend on `seed` and on the root's key and ring alone.
 */
function getTreePlaces(mode: OrbitMode, seed: number, root: Node): Place[] {
  const reach = REACH[mode.kind];
  const places: Place[] = [];
  let inside: readonly { key: string; offset: number }[] = [{ key: root.dot.key, offset: 0 }];
  for (const [index, { ring, budget }] of RINGS.entries()) {
    const depth = index - root.index;
    if (depth < 1) {
      continue;
    }
    const stride = getStride(mode, budget[mode.kind], depth);
    const most = Math.floor((depth * reach) / stride);
    const outside: Place[] = [];
    for (let step = -most; step <= most; step += 1) {
      const key = `${root.dot.key}.${ring}.${String(step)}`;
      const offset = getTurned(step * stride, stride * JITTER, getUnitHash(seed, key));
      const reached = inside.filter(place => Math.abs(place.offset - offset) <= reach);
      // A parent no further from the real node than its place stays in the tree's part of the ring whenever the place
      // does, so a neighbour that takes room leaves no place it spared without its parent.
      const nearer = reached.filter(place => Math.abs(place.offset) <= Math.abs(offset));
      const [parent] = (nearer.length > 0 ? nearer : reached).sort(
        (a, b) => Math.abs(a.offset - offset) - Math.abs(b.offset - offset),
      );
      if (parent) {
        outside.push({ index, key, offset, parent: parent.key });
      }
    }
    places.push(...outside);
    inside = outside;
  }
  return places;
}

/**
 * Returns the degrees between two neighbouring places of a tree of `mode` on a ring `depth` past its real node's that
 * holds `budget` simulated nodes. A light client's ring spreads them round the whole circle, and the trusted
 * provider's across its one fan, so its one tree holds about its budget.
 */
function getStride(mode: OrbitMode, budget: number, depth: number): number {
  switch (mode.kind) {
    case 'lightClient':
      return 360 / budget;
    case 'trustedProvider':
      return (2 * depth * REACH.trustedProvider) / budget;
  }
}

/**
 * Returns which of `count` even places, counted round the circle from the first's, the real node that joined
 * `order`th takes: the rank of its point in a sequence that splits the circle into thirds, then ninths, and so on.
 * Ranks of fixed points keep their order as points are added, so a new node always lands between two others.
 */
function getEvenPlace(order: number, count: number): number {
  const own = getThirdsPoint(order);
  return Array.from({ length: count }, (_, other) => getThirdsPoint(other)).filter(point => point < own).length;
}

/**
 * Returns a point in [0, 1) for `order`: its base 3 digits mirrored behind the point. Orders 0 to 2 fall on thirds,
 * and each later run of three takes one gap in each third, so the inner ring's three nodes stay a third of a turn
 * apart within one spacing at every count.
 */
function getThirdsPoint(order: number): number {
  let point = 0;
  let weight = 1 / 3;
  for (let rest = order; rest > 0; rest = Math.floor(rest / 3)) {
    point += (rest % 3) * weight;
    weight /= 3;
  }
  return point;
}

/** Returns `angle` turned by at most `spread` degrees either way, as `share` in [0, 1) says. */
function getTurned(angle: number, spread: number, share: number): number {
  return angle + (share * 2 - 1) * spread;
}

/** Returns how far apart two angles are around the circle, in degrees. */
function getAngleGap(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360;
  return Math.min(gap, 360 - gap);
}

/** Returns a number in [0, 1) that `seed` and `key` fix, spread evenly however alike two keys or seeds are. */
function getUnitHash(seed: number, key: string): number {
  // FNV-1a, then the MurmurHash3 finaliser so that keys differing in one character land far apart.
  let hash = 0x811c9dc5;
  for (const char of `${String(seed)}:${key}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32;
}
