// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which dots and links the landing page's orbit draws. CSS places and turns them, so a dot is only its ring and its
// angle at rest. The inner ring stands for what the visitor's centre reaches the network through, and the rings outside
// it are simulated.

export type OrbitRing = 'inner' | 'ring1' | 'ring2' | 'ring3' | 'ring4';

export type OrbitDot = {
  /** Stays the same while the dot exists, so a renderer keeps its element. */
  readonly key: string;
  /** Its angle at rest, in degrees. */
  readonly start: number;
  /** The one server a backend with no light client reaches the network through. */
  readonly server: boolean;
};

/** One end of a link: the centre, or a dot on a ring. */
export type OrbitEnd = {
  readonly ring: OrbitRing | 'centre';
  readonly start: number;
};

export type OrbitLink = {
  /** Stays the same while the link exists, so a renderer keeps its element. */
  readonly key: string;
  /** The end nearer the centre. */
  readonly from: OrbitEnd;
  readonly to: OrbitEnd;
};

export type OrbitLayout = {
  /** From the centre outward. */
  readonly rings: readonly { readonly ring: OrbitRing; readonly dots: readonly OrbitDot[] }[];
  readonly links: readonly OrbitLink[];
};

/** What the centre reaches the network through: the light client's peers, or one server. */
export type OrbitMode = { readonly kind: 'lightClient'; readonly peers: number } | { readonly kind: 'server' };

/** The most peers the inner ring draws, so a well connected light client does not crowd it. */
const MAX_PEERS = 24;

/** Each peer turns on from the last by this, so the ring fills evenly however many there are. */
const GOLDEN_ANGLE = 137.5;

/** The first peer's angle, and the server's, on the far side of the floor. */
const FIRST_START = 282;

// The simulated rings' dots, by their angle at rest, from the centre outward.
const OUTER_RINGS: readonly { ring: OrbitRing; starts: readonly number[] }[] = [
  { ring: 'ring1', starts: [-34, 17, 64, 148, 221, 283] },
  { ring: 'ring2', starts: [3, 41, 118, 139, 197, 262, 289, 344] },
  { ring: 'ring3', starts: [12, 37, 79, 125, 171, 203, 248, 301, 329] },
  { ring: 'ring4', starts: [6, 28, 61, 97, 132, 160, 189, 227, 266, 293, 338] },
];

const CENTRE: OrbitEnd = { ring: 'centre', start: 0 };

/**
 * Returns the orbit's dots and links for `mode`. Every dot links inward: an inner dot to the centre, any other to the
 * nearest dot on the ring inside its own, or to none while that ring is empty. Peer `i` keeps its angle whatever the
 * count, so a peer joining moves no other dot, and fewer peers drop the newest dots.
 */
export function getOrbitLayout(mode: OrbitMode): OrbitLayout {
  const rings: { ring: OrbitRing; dots: OrbitDot[] }[] = [
    { ring: 'inner', dots: getInnerDots(mode) },
    ...OUTER_RINGS.map(({ ring, starts }) => ({ ring, dots: starts.map(start => createDot(ring, start, false)) })),
  ];
  const links = rings.flatMap(({ ring, dots }, index) => {
    const inside = rings[index - 1];
    return dots.flatMap(({ start }) => {
      const to = { ring, start };
      if (!inside) {
        return [createLink(CENTRE, to)];
      }
      if (inside.dots.length === 0) {
        return [];
      }
      const nearest = inside.dots.reduce((best, other) =>
        getAngleGap(other.start, start) < getAngleGap(best.start, start) ? other : best,
      );
      return [createLink({ ring: inside.ring, start: nearest.start }, to)];
    });
  });
  return { rings, links };
}

function getInnerDots(mode: OrbitMode): OrbitDot[] {
  switch (mode.kind) {
    case 'lightClient':
      return Array.from({ length: Math.min(mode.peers, MAX_PEERS) }, (_, index) =>
        createDot('inner', (FIRST_START + index * GOLDEN_ANGLE) % 360, false),
      );
    case 'server':
      return [createDot('inner', FIRST_START, true)];
  }
}

function createDot(ring: OrbitRing, start: number, server: boolean): OrbitDot {
  return { key: getEndKey({ ring, start }), start, server };
}

function createLink(from: OrbitEnd, to: OrbitEnd): OrbitLink {
  return { key: `${getEndKey(from)}>${getEndKey(to)}`, from, to };
}

function getEndKey({ ring, start }: OrbitEnd): string {
  return `${ring}:${String(start)}`;
}

/** Returns how far apart two angles are around the circle, in degrees. */
function getAngleGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}
