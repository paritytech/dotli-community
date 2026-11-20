// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which dots the landing page's orbit draws. CSS places and turns them, so a dot is only its ring, its angle at rest
// and where its one link starts. What the visitor's centre really reaches the network through, its peers or one
// server, is spread evenly around the whole circle, whatever ring each node takes, and each is turned off its even
// place at random. Each node that joins takes a place between the ones already shown, so the first few stay spread
// round the circle however many follow. Each of those grows a simulated tree outward, like the peers of that peer.
// A light client's trees tile the circle, so the picture reads as the network going on behind the real connections.
// The server's one tree stays a narrow fan, and loose dots linked to nothing fill the rings around it, so a server
// backend's floor looks full but reads as one connection, not a network of its own. Every turn is drawn from a seed
// and the dot's key, so for one seed a dot keeps its turn while others come and go, and another seed lays out another
// picture.

type OrbitRing = 'inner' | 'ring1' | 'ring2' | 'ring3' | 'ring4';

/**
 * A peer of the light client, the one server a backend with no light client talks through, a simulated node of a real
 * node's tree, or a loose simulated dot linked to nothing.
 */
type OrbitDotKind = 'peer' | 'server' | 'simulated' | 'loose';

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
   * centre, at 0, for a peer or the server. Null for a loose dot, which has no link.
   */
  readonly from: number | null;
  readonly kind: OrbitDotKind;
  /** The caption beside a peer, naming it by its join order, or beside the server. A simulated or loose dot has none. */
  readonly label: string | null;
};

export type OrbitLayout = {
  /** From the centre outward, each with its radius in the orbit's length unit, which the renderer scales. */
  readonly rings: readonly { readonly ring: OrbitRing; readonly radius: number; readonly dots: readonly OrbitDot[] }[];
};

/** What the centre reaches the network through: the light client's peers, or one server. */
export type OrbitMode = { readonly kind: 'lightClient'; readonly peers: number } | { readonly kind: 'server' };

/** A dot with the index of the ring it sits on, counted from the centre. */
type Node = { readonly index: number; readonly dot: OrbitDot };

/**
 * A real node's tree that grows onto a ring: every node it holds, the real node first, its nodes on the ring inside,
 * and the part of the ring it spreads across.
 */
type Growth = {
  readonly tree: Node[];
  readonly parents: readonly [Node, ...Node[]];
  readonly low: number;
  readonly high: number;
  /**
   * How far in from each end of its part the outermost place sits, as a share of the spacing between places: half at
   * an end it shares with a neighbour, so the two trees' places keep that spacing too, and none at the end of its reach.
   */
  readonly insets: { readonly low: number; readonly high: number };
};

/**
 * The rings from the centre outward, each with its radius in the orbit's length unit, which `MIN_GAP` is in too, and
 * for each mode the most simulated nodes the trees hold on it and the loose dots it spreads round the whole circle. A
 * light client's ring holds twice the one inside it, so its trees branch ring by ring. The server's tree stays small,
 * and its loose dots and tree together never outnumber the light client's simulated nodes, so either field stays light
 * enough to sit behind the page.
 */
const RINGS: readonly {
  readonly ring: OrbitRing;
  readonly radius: number;
  readonly budget: Record<OrbitMode['kind'], number>;
  readonly loose: Record<OrbitMode['kind'], number>;
}[] = [
  { ring: 'inner', radius: 110, budget: { lightClient: 0, server: 0 }, loose: { lightClient: 0, server: 5 } },
  { ring: 'ring1', radius: 190, budget: { lightClient: 8, server: 2 }, loose: { lightClient: 0, server: 10 } },
  { ring: 'ring2', radius: 260, budget: { lightClient: 16, server: 4 }, loose: { lightClient: 0, server: 16 } },
  { ring: 'ring3', radius: 340, budget: { lightClient: 32, server: 6 }, loose: { lightClient: 0, server: 24 } },
  { ring: 'ring4', radius: 430, budget: { lightClient: 64, server: 8 }, loose: { lightClient: 0, server: 36 } },
];

/** The ring each real node takes in join order: ring `k` from the centre holds `3 * (k + 1)`, filled from the centre. */
const REAL_RINGS = RINGS.flatMap((_, index) => Array.from({ length: 3 * (index + 1) }, () => index));

/** The first real node's even place, in degrees, on the far side of the floor. */
const OFFSET = 282;

/**
 * How far a dot turns at most either way off its even place, among the real nodes, among its tree's places on its ring
 * or among a ring's loose places, as a share of the spacing between those places. Under half, so two neighbours never
 * meet or swap. A light client's simulated node also sits at most this share of the peers' spacing from the node it
 * grew from.
 */
const JITTER = 0.3;

/**
 * How far, in degrees, the server's tree reaches further either way on each ring out, which is also the most a node of
 * it sits from the node it grew from. Small, so the tree grows out in one narrow fan.
 */
const SERVER_REACH = 8;

/** The least distance along its ring between a simulated node and another node on that ring. */
const MIN_GAP = 10;

/**
 * Returns the orbit's dots for `mode`, every turn drawn from `seed`. The `count` real nodes take the places
 * `360 / count * k` past the first's, each turned by at most `JITTER` of that spacing. A node that joins takes a place
 * between two neighbours, and the others keep their order round the circle and close up by little. Peers take rings from
 * the centre outward in join order, and each peer's and the server's link starts at the centre.
 *
 * Each real node grows a tree of simulated nodes outward to the last ring, its link starting at the node it grew from.
 * Ring by ring, the trees split the ring between them, each tree takes a share of the ring's budget in proportion to its
 * part, spreads its share evenly across it, and links each to its nearest node on the ring inside, moved to at most the
 * mode's reach from it: `JITTER` of the peers' spacing, or `SERVER_REACH`. A tree so reaches further on each ring out,
 * and fans wider the further out.
 *
 * The server's rings then spread loose dots, with no link, over even places round the whole circle from a turn of the
 * seed's, each turned by at most `JITTER` of their spacing. A place within a tree's reach on its ring, and one reach
 * more so the tree stands apart, is left empty.
 *
 * A simulated or loose dot less than `MIN_GAP` along its ring from a dot placed before it is left out.
 */
export function getOrbitLayout(mode: OrbitMode, seed: number): OrbitLayout {
  const real = getRealNodes(mode);
  const spacing = 360 / real.length;
  const reach = getReach(mode, spacing);
  const roots = real.map(({ index, key, kind }, order): Node => {
    const turn = spacing * JITTER;
    const start = getTurned(OFFSET + getEvenPlace(order, real.length) * spacing, turn, getUnitHash(seed, key));
    return { index, dot: { key, start, from: 0, kind, label: key } };
  });
  const trees = [...roots].sort((a, b) => a.dot.start - b.dot.start).map((root): Node[] => [root]);
  const nodes = [...roots];
  for (const [index, { ring, radius, budget, loose }] of RINGS.entries()) {
    const clearance = (MIN_GAP / radius) * (180 / Math.PI);
    const growing = getGrowth(trees, index, reach);
    const reached = growing.reduce((sum, { low, high }) => sum + high - low, 0);
    // Every tree takes one place, so none stops, and the rest of the budget goes by the part each spreads across.
    // Each share is rounded on the running total, so the shares add up to the budget.
    const rest = budget[mode.kind] - growing.length;
    let share = 0;
    for (const { tree, parents, low, high, insets } of growing) {
      const before = Math.round(share);
      share += (rest * (high - low)) / reached;
      // No more places than keep two neighbours, each turned off its place, at least the clearance apart, though one
      // place always fits.
      const room = Math.floor(((high - low) * (1 - 2 * JITTER)) / clearance + 1 - insets.low - insets.high);
      const count = Math.min(1 + Math.round(share) - before, Math.max(1, room));
      const width = count === 1 ? high - low : (high - low) / (count - 1 + insets.low + insets.high);
      const children = new Map<Node, number>();
      for (let place = 0; place < count; place += 1) {
        const centre = count === 1 ? (low + high) / 2 : low + width * (place + insets.low);
        const parent = getNearest(parents, centre);
        const child = children.get(parent) ?? 0;
        children.set(parent, child + 1);
        const key = `${parent.dot.key}.${String(child)}`;
        const turned = getTurned(centre, width * JITTER, getUnitHash(seed, key));
        const start = Math.min(Math.max(turned, parent.dot.start - reach), parent.dot.start + reach);
        if (nodes.some(other => other.index === index && getAngleGap(other.dot.start, start) < clearance)) {
          continue;
        }
        const node: Node = { index, dot: { key, start, from: parent.dot.start, kind: 'simulated', label: null } };
        nodes.push(node);
        tree.push(node);
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
function getRealNodes(mode: OrbitMode): { index: number; key: string; kind: 'peer' | 'server' }[] {
  switch (mode.kind) {
    case 'lightClient':
      return REAL_RINGS.slice(0, mode.peers).map((index, peer) => ({
        index,
        key: `[peer#${String(peer + 1)}]`,
        kind: 'peer',
      }));
    case 'server':
      return [{ index: 0, key: '[server]', kind: 'server' }];
  }
}

/**
 * Returns how far, in degrees, a tree of `mode` reaches further either way on each ring out, given the real nodes'
 * `spacing`.
 */
function getReach(mode: OrbitMode, spacing: number): number {
  switch (mode.kind) {
    case 'lightClient':
      return spacing * JITTER;
    case 'server':
      return SERVER_REACH;
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

/**
 * Returns the trees of `trees`, in order round the circle, that grow onto ring `index`, each with the part of the ring
 * it spreads across. A tree reaches `bound` further either way on each ring out from its real node, so a tree that
 * grew narrow on one ring still widens toward the side with more room. Two neighbours whose reaches overlap split the
 * overlap at its middle, which for two trees as deep is the midpoint between their real nodes, so the trees tile the
 * ring and a deeper tree fills the room a shallower one cannot reach. A real node on the ring is a neighbour that
 * reaches no further than itself, so the trees beside it stop halfway to it.
 */
function getGrowth(trees: readonly Node[][], index: number, bound: number): Growth[] {
  const reaching = trees.flatMap(tree => {
    const [root] = tree;
    const parents = tree.filter(node => node.index === index - 1);
    if (!root || root.index > index || (root.index < index && parents.length === 0)) {
      return [];
    }
    const reach = (index - root.index) * bound;
    return [{ tree, parents, low: root.dot.start - reach, high: root.dot.start + reach }];
  });
  return reaching.flatMap((growth, order): Growth[] => {
    const [first, ...others] = growth.parents;
    if (!first) {
      return [];
    }
    // The first tree's previous and the last's next are its neighbours round the circle, a turn away.
    const previous = (reaching.at(order - 1)?.high ?? growth.high) - (order === 0 ? 360 : 0);
    const next = reaching[order + 1]?.low ?? (reaching[0]?.low ?? growth.low) + 360;
    const low = Math.max(growth.low, (previous + growth.low) / 2);
    const high = Math.min(growth.high, (growth.high + next) / 2);
    const insets = { low: low > growth.low ? 0.5 : 0, high: high < growth.high ? 0.5 : 0 };
    return [{ tree: growth.tree, parents: [first, ...others], low, high, insets }];
  });
}

/** Returns the node of `nodes` whose angle is nearest `angle`. */
function getNearest(nodes: readonly [Node, ...Node[]], angle: number): Node {
  return nodes.reduce((nearest, node) =>
    Math.abs(node.dot.start - angle) < Math.abs(nearest.dot.start - angle) ? node : nearest,
  );
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
