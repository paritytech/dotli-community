// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which dots the landing page's orbit draws. CSS places and turns them, so a dot is only its ring, its angle at rest
// and where its one link starts. What the visitor's centre really reaches the network through, its peers or one server, takes fixed
// slots on the rings. Each of those grows a simulated cascade outward, like the peers of that peer, so the picture reads
// as the network going on behind the real connections.

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

/** The real nodes' slots in the order they fill: ring `k` from the centre holds `3 * (k + 1)`, evenly spaced. */
const SLOTS = RINGS.flatMap(({ offset }, index) => {
  const count = 3 * (index + 1);
  return Array.from({ length: count }, (_, slot) => ({ index, start: (offset + (slot * 360) / count) % 360 }));
});

/** The least angle, in degrees, between a simulated node and any slot or other node on its ring. */
const MIN_GAP = 6;

/**
 * Returns the orbit's dots for `mode`. Peer `i` always takes the same slot, filling from the inner ring outward, and
 * each peer's and the server's link starts at the centre. Each real node puts one or two simulated nodes on the next
 * ring out near its own angle, and each of those does the same up to the outermost ring, its link starting at the node
 * it came from. A cascade's shape follows from its root's key alone, and the cascades are laid in join order, so a peer
 * joining adds its own dots and changes no other. A simulated node keeps clear of every slot, so none ever sits on a
 * real one.
 */
export function getOrbitLayout(mode: OrbitMode): OrbitLayout {
  const real = getRealNodes(mode);
  const placed: Node[] = [...real];
  for (const root of real) {
    const growing = [root];
    for (let parent = growing.pop(); parent; parent = growing.pop()) {
      const index = parent.index + 1;
      if (index === RINGS.length) {
        continue;
      }
      for (const { key, start } of getCascadeChildren(parent)) {
        if (placed.some(node => node.index === index && getAngleGap(node.dot.start, start) < MIN_GAP)) {
          continue;
        }
        const child: Node = { index, dot: { key, start, from: parent.dot.start, kind: 'simulated', label: null } };
        placed.push(child);
        growing.push(child);
      }
    }
  }
  return {
    rings: RINGS.map(({ ring }, index) => ({
      ring,
      dots: placed.filter(node => node.index === index).map(({ dot }) => dot),
    })),
  };
}

function getRealNodes(mode: OrbitMode): Node[] {
  switch (mode.kind) {
    case 'lightClient':
      return SLOTS.slice(0, mode.peers).map(({ index, start }, peer) => {
        const label = `[peer#${String(peer + 1)}]`;
        return { index, dot: { key: label, start, from: 0, kind: 'peer', label } };
      });
    case 'server':
      return SLOTS.slice(0, 1).map(({ index, start }) => ({
        index,
        dot: { key: '[server]', start, from: 0, kind: 'server', label: '[server]' },
      }));
  }
}

/** Returns the one or two nodes `parent` puts on the next ring out, each turned a little off its angle. */
function getCascadeChildren(parent: Node): { key: string; start: number }[] {
  const count = getUnitHash(parent.dot.key) < 1 / 3 ? 2 : 1;
  return Array.from({ length: count }, (_, child) => {
    const key = `${parent.dot.key}.${String(child)}`;
    const share = getUnitHash(key);
    // A lone child turns either way. Two children fan out to both sides, at least one gap apart.
    const turn = count === 1 ? (share * 2 - 1) * 12 : (child === 0 ? -1 : 1) * (MIN_GAP / 2 + share * 10);
    return { key, start: getClearOfSlots(parent.index + 1, Math.round(parent.dot.start + turn)) };
  });
}

/** Returns `start`, moved off the nearest slot on ring `index` when it falls within the gap of it. */
function getClearOfSlots(index: number, start: number): number {
  const angle = (start + 360) % 360;
  for (const slot of SLOTS) {
    const offset = ((angle - slot.start + 540) % 360) - 180;
    if (slot.index === index && Math.abs(offset) < MIN_GAP) {
      return (slot.start + (offset < 0 ? -MIN_GAP : MIN_GAP) + 360) % 360;
    }
  }
  return angle;
}

/** Returns how far apart two angles are around the circle, in degrees. */
function getAngleGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** Returns a number in [0, 1) that `text` fixes, spread evenly however alike two texts are. */
function getUnitHash(text: string): number {
  // FNV-1a, then the MurmurHash3 finaliser so that keys differing in one character land far apart.
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32;
}
