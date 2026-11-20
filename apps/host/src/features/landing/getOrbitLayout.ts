// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which dots and links the landing page's orbit draws. CSS places and turns them, so a dot is only its ring and its
// angle at rest.

export type OrbitRing = 'inner' | 'ring1' | 'ring2' | 'ring3' | 'ring4';

export type OrbitDot = {
  /** Stays the same while the dot exists, so a renderer keeps its element. */
  readonly key: string;
  /** Its angle at rest, in degrees. */
  readonly start: number;
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

// Each ring's dots, by their angle at rest, from the centre outward.
const RINGS: readonly { ring: OrbitRing; starts: readonly number[] }[] = [
  { ring: 'inner', starts: [-78, 30, 158] },
  { ring: 'ring1', starts: [-34, 17, 64, 148, 221, 283] },
  { ring: 'ring2', starts: [3, 41, 118, 139, 197, 262, 289, 344] },
  { ring: 'ring3', starts: [12, 37, 79, 125, 171, 203, 248, 301, 329] },
  { ring: 'ring4', starts: [6, 28, 61, 97, 132, 160, 189, 227, 266, 293, 338] },
];

const CENTRE: OrbitEnd = { ring: 'centre', start: 0 };

/**
 * Returns the orbit's dots and links. Every dot links inward: an inner dot to the centre, any other to the nearest dot
 * on the ring inside its own.
 */
export function getOrbitLayout(): OrbitLayout {
  const rings = RINGS.map(({ ring, starts }) => ({
    ring,
    dots: starts.map(start => ({ key: getEndKey({ ring, start }), start })),
  }));
  const links = rings.flatMap(({ ring, dots }, index) => {
    const inside = rings[index - 1];
    return dots.map(({ start }) => {
      const to = { ring, start };
      if (!inside) {
        return createLink(CENTRE, to);
      }
      const nearest = inside.dots.reduce((best, other) =>
        gap(other.start, start) < gap(best.start, start) ? other : best,
      );
      return createLink({ ring: inside.ring, start: nearest.start }, to);
    });
  });
  return { rings, links };
}

function createLink(from: OrbitEnd, to: OrbitEnd): OrbitLink {
  return { key: `${getEndKey(from)}>${getEndKey(to)}`, from, to };
}

function getEndKey({ ring, start }: OrbitEnd): string {
  return `${ring}:${String(start)}`;
}

/** Returns how far apart two angles are around the circle, in degrees. */
function gap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}
