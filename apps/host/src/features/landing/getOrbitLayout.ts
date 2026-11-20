// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which dots the landing page's orbit draws. CSS places and turns them, so a dot is only its ring, its angle at rest
// and where its one link starts. What the visitor's centre really reaches the network through, its peers or one
// server, takes evenly spaced slots on the rings, each dot turned off its slot at random. Each of those grows a
// simulated cascade outward, like the peers of that peer, so the picture reads as the network going on behind the real
// connections. Every turn is drawn from a seed and the dot's key, so for one seed a dot stays put while others come and
// go, and another seed lays out another picture.

type OrbitRing = 'inner' | 'ring1' | 'ring2' | 'ring3' | 'ring4';

/** A peer of the light client, the one server a backend with no light client talks through, or a simulated node. */
type OrbitDotKind = 'peer' | 'server' | 'simulated';

export type OrbitDot = {
  /** Stays the same while the dot exists, so a renderer keeps its element. A dot never changes kind. */
  readonly key: string;
  /** Its angle at rest, in degrees. */
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

// The rings from the centre outward, each with the angle of its first slot. The offsets keep one ring's slots off the
// line of its neighbours', and put the first peer, or the server, on the far side of the floor.
const RINGS: readonly { ring: OrbitRing; offset: number }[] = [
  { ring: 'inner', offset: 282 },
  { ring: 'ring1', offset: 15 },
  { ring: 'ring2', offset: 33 },
  { ring: 'ring3', offset: 8 },
  { ring: 'ring4', offset: 19 },
];

/**
 * The real nodes' slots in the order they fill: ring `k` from the centre holds `3 * (k + 1)`, evenly spaced. A real
 * node turns off its slot by at most a third of the spacing either way, so two neighbours never meet or swap.
 */
const SLOTS = RINGS.flatMap(({ offset }, index) => {
  const count = 3 * (index + 1);
  const spacing = 360 / count;
  return Array.from({ length: count }, (_, slot) => ({ index, start: offset + slot * spacing, spread: spacing / 3 }));
});

/** How far, in degrees, a simulated node turns at most either way off the node it grew from. */
const CASCADE_SPREAD = 40;

/** The least angle, in degrees, between a simulated node and another node, or a place a real one takes, on its ring. */
const MIN_GAP = 6;

/**
 * Returns the orbit's dots for `mode`, every turn drawn from `seed`. Peer `i` always takes the same slot, filling from
 * the inner ring outward, and each peer's and the server's link starts at the centre. Each real node puts one or two
 * simulated nodes on the next ring out within the cascade spread of its own angle, and each of those does the same up
 * to the outermost ring, its link starting at the node it came from, so a simulated link spans no more than that spread
 * at rest. A simulated node too close to a place a real node can take, or to an earlier node, is left out with its own
 * cascade. The cascades are laid in join order, so for one seed a peer joining adds its own dots and changes no other.
 */
export function getOrbitLayout(mode: OrbitMode, seed: number): OrbitLayout {
  const { shown, possible } = getRealNodes(mode, seed);
  const simulated: Node[] = [];
  for (const root of shown) {
    const growing = [root];
    for (let parent = growing.pop(); parent; parent = growing.pop()) {
      const index = parent.index + 1;
      if (index === RINGS.length) {
        continue;
      }
      for (const { key, start } of getCascadeChildren(parent, seed)) {
        const crowded = [...possible, ...simulated].some(
          node => node.index === index && getAngleGap(node.dot.start, start) < MIN_GAP,
        );
        if (crowded) {
          continue;
        }
        const child: Node = { index, dot: { key, start, from: parent.dot.start, kind: 'simulated', label: null } };
        simulated.push(child);
        growing.push(child);
      }
    }
  }
  const nodes = [...shown, ...simulated];
  return {
    rings: RINGS.map(({ ring }, index) => ({
      ring,
      dots: nodes.filter(node => node.index === index).map(({ dot }) => dot),
    })),
  };
}

/**
 * Returns the real nodes `mode` shows, and every real node its kind of mode can show, peers yet to join included, so
 * the cascades keep clear of a place before its node arrives.
 */
function getRealNodes(mode: OrbitMode, seed: number): { shown: Node[]; possible: Node[] } {
  switch (mode.kind) {
    case 'lightClient': {
      const possible = SLOTS.map(({ index, start, spread }, peer): Node => {
        const label = `[peer#${String(peer + 1)}]`;
        const turned = getTurned(start, spread, getUnitHash(seed, label));
        return { index, dot: { key: label, start: turned, from: 0, kind: 'peer', label } };
      });
      return { shown: possible.slice(0, mode.peers), possible };
    }
    case 'server': {
      const servers = SLOTS.slice(0, 1).map(({ index, start, spread }): Node => {
        const label = '[server]';
        const turned = getTurned(start, spread, getUnitHash(seed, label));
        return { index, dot: { key: label, start: turned, from: 0, kind: 'server', label } };
      });
      return { shown: servers, possible: servers };
    }
  }
}

/** Returns the one or two nodes `parent` puts on the next ring out, each within the cascade spread of its angle. */
function getCascadeChildren(parent: Node, seed: number): { key: string; start: number }[] {
  const count = getUnitHash(seed, `${parent.dot.key}:children`) < 1 / 3 ? 2 : 1;
  return Array.from({ length: count }, (_, child) => {
    const key = `${parent.dot.key}.${String(child)}`;
    return { key, start: getTurned(parent.dot.start, CASCADE_SPREAD, getUnitHash(seed, key)) };
  });
}

/** Returns `angle` turned by at most `spread` degrees either way, as `share` in [0, 1) says, in whole degrees. */
function getTurned(angle: number, spread: number, share: number): number {
  const turned = Math.round(angle + (share * 2 - 1) * spread);
  return ((turned % 360) + 360) % 360;
}

/** Returns how far apart two angles are around the circle, in degrees. */
function getAngleGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
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
