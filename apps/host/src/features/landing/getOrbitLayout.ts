// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which dots and links the landing page's orbit draws. CSS places and turns them, so a dot is only its ring and its
// angle at rest. Each ring has fixed slots. What the visitor's centre reaches the network through fills them from the
// inner ring outward, and a slot nothing fills shows a simulated dot, so the field reads as the network going on.

export type OrbitRing = 'inner' | 'ring1' | 'ring2' | 'ring3' | 'ring4';

/** A peer of the light client, the one server a backend with no light client talks through, or neither. */
type OrbitDotKind = 'peer' | 'server' | 'simulated';

export type OrbitDot = {
  /** Stays the same while the slot exists, whatever fills it, so a renderer keeps its element. */
  readonly key: string;
  /** Its angle at rest, in degrees. */
  readonly start: number;
  readonly kind: OrbitDotKind;
  /** The caption beside a peer, naming it by its join order, or beside the server. A simulated dot has none. */
  readonly label: string | null;
};

/** One end of a link: the centre, or a dot on a ring. */
export type OrbitEnd = {
  readonly ring: OrbitRing | 'centre';
  readonly start: number;
};

/** A real connection from the centre to a peer or the server, or one between simulated dots. */
type OrbitLinkKind = 'real' | 'simulated';

export type OrbitLink = {
  /** Stays the same while the link exists, so a renderer keeps its element. */
  readonly key: string;
  /** The end nearer the centre. */
  readonly from: OrbitEnd;
  readonly to: OrbitEnd;
  readonly kind: OrbitLinkKind;
};

export type OrbitLayout = {
  /** From the centre outward. */
  readonly rings: readonly { readonly ring: OrbitRing; readonly dots: readonly OrbitDot[] }[];
  readonly links: readonly OrbitLink[];
};

/** What the centre reaches the network through: the light client's peers, or one server. */
export type OrbitMode = { readonly kind: 'lightClient'; readonly peers: number } | { readonly kind: 'server' };

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
 * Returns the orbit's dots and links for `mode`. Ring `k` from the centre has `3 * (k + 1)` slots, and peer `i` always
 * takes the same one, filling from the inner ring outward, so a peer joining moves no other dot and fewer peers empty
 * the newest slots first. The centre links straight to each peer and to the server, which link to nothing else. A
 * simulated dot links to the nearest simulated dot on the ring inside its own, or to none while that ring has none.
 */
export function getOrbitLayout(mode: OrbitMode): OrbitLayout {
  const rings = RINGS.map(({ ring, offset }, index) => {
    const slots = 3 * (index + 1);
    // The slots of the rings inside this one, which the peers before this ring's first take.
    const filledInside = (3 * index * (index + 1)) / 2;
    const dots = Array.from({ length: slots }, (_, slot): OrbitDot => {
      const start = (offset + (slot * 360) / slots) % 360;
      return { key: getEndKey({ ring, start }), start, ...getSlotFill(mode, filledInside + slot) };
    });
    return { ring, dots };
  });
  const links = rings.flatMap(({ ring, dots }, index) => {
    const inside = rings[index - 1];
    const simulatedInside: OrbitEnd[] = inside
      ? inside.dots.filter(({ kind }) => kind === 'simulated').map(({ start }) => ({ ring: inside.ring, start }))
      : [];
    return dots.flatMap(dot => {
      const to = { ring, start: dot.start };
      if (dot.kind !== 'simulated') {
        return [createLink({ ring: 'centre', start: 0 }, to, 'real')];
      }
      const nearest = simulatedInside.reduce<OrbitEnd | null>(
        (best, other) =>
          best === null || getAngleGap(other.start, dot.start) < getAngleGap(best.start, dot.start) ? other : best,
        null,
      );
      return nearest === null ? [] : [createLink(nearest, to, 'simulated')];
    });
  });
  return { rings, links };
}

/** Returns what fills the slot that peer `index`, counted from 0, takes. */
function getSlotFill(mode: OrbitMode, index: number): Pick<OrbitDot, 'kind' | 'label'> {
  switch (mode.kind) {
    case 'lightClient':
      return index < mode.peers
        ? { kind: 'peer', label: `[peer#${String(index + 1)}]` }
        : { kind: 'simulated', label: null };
    case 'server':
      return index === 0 ? { kind: 'server', label: '[server]' } : { kind: 'simulated', label: null };
  }
}

function createLink(from: OrbitEnd, to: OrbitEnd, kind: OrbitLinkKind): OrbitLink {
  return { key: `${getEndKey(from)}>${getEndKey(to)}`, from, to, kind };
}

function getEndKey({ ring, start }: OrbitEnd): string {
  return `${ring}:${String(start)}`;
}

/** Returns how far apart two angles are around the circle, in degrees. */
function getAngleGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}
