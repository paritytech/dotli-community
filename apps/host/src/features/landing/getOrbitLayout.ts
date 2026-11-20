// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which dots the landing page's orbit draws. CSS places and turns them, so a dot is only its ring, its angle at rest
// and where its one link starts. What the visitor's centre really reaches the network through, its peers or one
// server, is spread evenly around the whole circle, whatever ring each node takes, and each is turned off its even
// place at random. Each node that joins takes a place between the ones already shown, so the first few stay spread
// round the circle however many follow. Each of those grows a simulated cascade outward, like the peers of that peer, so the picture reads as
// the network going on behind the real connections. Every turn is a share of the real nodes' spacing, drawn from a seed
// and the dot's key, so for one seed a dot keeps its share while others come and go, and another seed lays out another
// picture.

type OrbitRing = 'inner' | 'ring1' | 'ring2' | 'ring3' | 'ring4';

/** A peer of the light client, the one server a backend with no light client talks through, or a simulated node. */
type OrbitDotKind = 'peer' | 'server' | 'simulated';

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
   * centre, at 0, for a peer or the server.
   */
  readonly from: number;
  readonly kind: OrbitDotKind;
  /** The caption beside a peer, naming it by its join order, or beside the server. A simulated dot has none. */
  readonly label: string | null;
};

export type OrbitLayout = {
  /** From the centre outward. */
  readonly rings: readonly { readonly ring: OrbitRing; readonly dots: readonly OrbitDot[] }[];
};

/** What the centre reaches the network through: the light client's peers, or one server. */
export type OrbitMode = { readonly kind: 'lightClient'; readonly peers: number } | { readonly kind: 'server' };

/** A dot with the index of the ring it sits on, counted from the centre. */
type Node = { readonly index: number; readonly dot: OrbitDot };

/** The rings from the centre outward. */
const RINGS: readonly OrbitRing[] = ['inner', 'ring1', 'ring2', 'ring3', 'ring4'];

/** The ring each real node takes in join order: ring `k` from the centre holds `3 * (k + 1)`, filled from the centre. */
const REAL_RINGS = RINGS.flatMap((_, index) => Array.from({ length: 3 * (index + 1) }, () => index));

/** The first real node's even place, in degrees, on the far side of the floor. */
const OFFSET = 282;

/**
 * How far a dot turns at most either way, off its even place for a real node or off the node it grew from for a
 * simulated one, as a share of the real nodes' spacing. Under half, so two real neighbours never meet or swap.
 */
const JITTER = 0.3;

/** The least angle, in degrees, between a simulated node and another node on its ring. */
const MIN_GAP = 6;

/**
 * Returns the orbit's dots for `mode`, every turn drawn from `seed`. The `count` real nodes take the places
 * `360 / count * k` past the first's, each turned by at most `JITTER` of that spacing. A node that joins takes a place
 * between two neighbours, and the others keep their order round the circle and close up by little. Peers take rings from
 * the centre outward in join order, and each peer's and the server's link starts at the centre. Each real node puts one or two simulated nodes on the next ring out within the same turn
 * of its own angle, and each of those does the same up to the outermost ring, its link starting at the node it came
 * from, so a cascade stays within its real node's share of the circle. A simulated node too close to a node placed
 * before it on its ring is left out with its own cascade.
 */
export function getOrbitLayout(mode: OrbitMode, seed: number): OrbitLayout {
  const real = getRealNodes(mode);
  const spacing = 360 / real.length;
  const spread = spacing * JITTER;
  const roots = real.map(({ index, key, kind }, order): Node => {
    const start = getTurned(OFFSET + getEvenPlace(order, real.length) * spacing, spread, getUnitHash(seed, key));
    return { index, dot: { key, start, from: 0, kind, label: key } };
  });
  const nodes = [...roots];
  for (const root of roots) {
    const growing = [root];
    for (let parent = growing.pop(); parent; parent = growing.pop()) {
      const index = parent.index + 1;
      if (index === RINGS.length) {
        continue;
      }
      for (const { key, start } of getCascadeChildren(parent, spread, seed)) {
        if (nodes.some(node => node.index === index && getAngleGap(node.dot.start, start) < MIN_GAP)) {
          continue;
        }
        const child: Node = { index, dot: { key, start, from: parent.dot.start, kind: 'simulated', label: null } };
        nodes.push(child);
        growing.push(child);
      }
    }
  }
  return {
    rings: RINGS.map((ring, index) => ({
      ring,
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

/** Returns the one or two nodes `parent` puts on the next ring out, each within `spread` degrees of its angle. */
function getCascadeChildren(parent: Node, spread: number, seed: number): { key: string; start: number }[] {
  const count = getUnitHash(seed, `${parent.dot.key}:children`) < 1 / 3 ? 2 : 1;
  return Array.from({ length: count }, (_, child) => {
    const key = `${parent.dot.key}.${String(child)}`;
    return { key, start: getTurned(parent.dot.start, spread, getUnitHash(seed, key)) };
  });
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
