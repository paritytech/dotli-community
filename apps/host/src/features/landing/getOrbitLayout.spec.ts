// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  getOrbitLayout,
  type OrbitDot,
  type OrbitEnd,
  type OrbitLayout,
  type OrbitMode,
  type OrbitRing,
} from './getOrbitLayout.js';

describe('getOrbitLayout', () => {
  it('As a visitor, I see 3, 6, 9, 12 and 15 slots on the rings from the centre outward, filled by peers from the inner ring out', () => {
    // When
    const layout = getOrbitLayout(lightClient(5));

    // Then
    expect(layout.rings.map(({ dots }) => dots.map(({ kind }) => kind).join(','))).toEqual([
      'peer,peer,peer',
      'peer,peer,simulated,simulated,simulated,simulated',
      Array(9).fill('simulated').join(','),
      Array(12).fill('simulated').join(','),
      Array(15).fill('simulated').join(','),
    ]);
  });

  it('As a visitor, I see a joining peer fill the next slot and every other dot stay as it was', () => {
    // Given
    const before = listAllDots(getOrbitLayout(lightClient(5)));

    // When
    const after = listAllDots(getOrbitLayout(lightClient(6)));

    // Then
    expect(after.filter((dot, index) => JSON.stringify(dot) !== JSON.stringify(before[index]))).toEqual([
      { ...before[5], kind: 'peer', label: '[peer#6]' },
    ]);
  });

  it('As a visitor whose light client has more peers than slots, I see all 45 slots filled', () => {
    // When
    const layout = getOrbitLayout(lightClient(50));

    // Then
    expect(listAllDots(layout).filter(({ kind }) => kind === 'peer')).toHaveLength(45);
  });

  it('As a visitor, I see each peer labelled by its join order, and no simulated dot labelled', () => {
    // When
    const layout = getOrbitLayout(lightClient(4));

    // Then
    expect(layout.rings.map(({ dots }) => dots.map(({ label }) => label).filter(label => label !== null))).toEqual([
      ['[peer#1]', '[peer#2]', '[peer#3]'],
      ['[peer#4]'],
      [],
      [],
      [],
    ]);
  });

  it('As a visitor whose light client has peers, I see the centre linked straight to each peer, and no peer linked to anything else', () => {
    // When
    const layout = getOrbitLayout(lightClient(4));

    // Then
    const peers = listPeers(layout);
    expect(listLinks(layout).filter(link => link.split(/[> ]/).some(end => peers.includes(end)))).toEqual(
      peers.map(peer => `centre:0>${peer} real`),
    );
  });

  it('As a visitor, I see each simulated dot linked from the nearest simulated dot on the ring inside, and one with none there unlinked', () => {
    // When
    const layout = getOrbitLayout(lightClient(3));

    // Then
    expect(listSimulatedLinkEnds(layout)).toEqual(listSimulated(layout).filter(dot => !dot.startsWith('ring1:')));
  });

  it('As a visitor whose light client has no peers yet, I see every slot simulated and nothing linked from the centre', () => {
    // When
    const layout = getOrbitLayout(lightClient(0));

    // Then
    expect(listPeers(layout)).toEqual([]);
    expect(listLinks(layout).filter(link => link.startsWith('centre:'))).toEqual([]);
  });

  it('As a visitor on a server backend, I see one server, labelled as the server, in the inner ring and linked from the centre', () => {
    // When
    const layout = getOrbitLayout({ kind: 'server' });

    // Then
    expect(listAllDots(layout).filter(({ kind }) => kind !== 'simulated')).toEqual([
      expect.objectContaining({ kind: 'server', label: '[server]' }),
    ]);
    expect(listLinks(layout).filter(link => link.endsWith(' real'))).toEqual(['centre:0>inner:282 real']);
  });

  it('As a visitor, I see a simulated dot just short of 360 deg linked to the nearest one inside across 0 deg', () => {
    // When
    const layout = getOrbitLayout(lightClient(0));

    // Then
    expect(findLinkFrom(layout, 'ring2', 353)).toEqual({ ring: 'ring1', start: 15 });
  });
});

function lightClient(peers: number): OrbitMode {
  return { kind: 'lightClient', peers };
}

function listAllDots(layout: OrbitLayout) {
  return layout.rings.flatMap(({ dots }) => dots);
}

/** The peers, in join order. */
function listPeers(layout: OrbitLayout): string[] {
  return listOfKind(layout, 'peer');
}

/** The simulated dots, from the centre outward. */
function listSimulated(layout: OrbitLayout): string[] {
  return listOfKind(layout, 'simulated');
}

function listOfKind(layout: OrbitLayout, kind: OrbitDot['kind']): string[] {
  return layout.rings.flatMap(({ ring, dots }) =>
    dots.filter(dot => dot.kind === kind).map(({ start }) => getEnd({ ring, start })),
  );
}

/** Each link as its two ends and its kind, in the layout's order. */
function listLinks(layout: OrbitLayout): string[] {
  return layout.links.map(({ from, to, kind }) => `${getEnd(from)}>${getEnd(to)} ${kind}`);
}

/** The outer ends of the links between simulated dots, each only when its inner end is simulated too. */
function listSimulatedLinkEnds(layout: OrbitLayout): string[] {
  const simulated = listSimulated(layout);
  return layout.links
    .filter(
      ({ from, to, kind }) =>
        kind === 'simulated' && simulated.includes(getEnd(from)) && simulated.includes(getEnd(to)),
    )
    .map(({ to }) => getEnd(to));
}

function getEnd({ ring, start }: OrbitEnd): string {
  return `${ring}:${String(start)}`;
}

function findLinkFrom(layout: OrbitLayout, ring: OrbitRing, start: number) {
  return layout.links.find(({ to }) => to.ring === ring && to.start === start)?.from;
}
