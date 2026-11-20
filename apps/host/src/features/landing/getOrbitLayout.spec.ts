// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getOrbitLayout, type OrbitLayout, type OrbitMode, type OrbitRing } from './getOrbitLayout.js';

describe('getOrbitLayout', () => {
  it('As a visitor whose light client has peers, I see every dot linked once, inward from the ring inside its own or from the centre', () => {
    // When
    const layout = getOrbitLayout(lightClient(5));

    // Then
    expect(listLinkedEnds(layout)).toEqual(listDots(layout));
  });

  it('As a visitor, I see one inner dot per peer, and a peer joining moves no other dot', () => {
    // Given
    const before = getOrbitLayout(lightClient(5));

    // When
    const after = getOrbitLayout(lightClient(6));

    // Then
    expect(getInner(before)).toHaveLength(5);
    expect(getInner(after).slice(0, 5)).toEqual(getInner(before));
  });

  it('As a visitor whose light client has many peers, I see at most 24 inner dots', () => {
    // When
    const layout = getOrbitLayout(lightClient(30));

    // Then
    expect(getInner(layout)).toHaveLength(24);
  });

  it('As a visitor whose light client has no peers yet, I see an empty inner ring and the ring outside it unlinked', () => {
    // When
    const layout = getOrbitLayout(lightClient(0));

    // Then
    expect(getInner(layout)).toEqual([]);
    expect(listLinkedEnds(layout)).toEqual(listDots(layout).filter(dot => !dot.startsWith('ring1:')));
  });

  it('As a visitor on a server backend, I see one server in the inner ring that every link out of the centre routes through', () => {
    // When
    const layout = getOrbitLayout({ kind: 'server' });

    // Then
    expect(getInner(layout)).toEqual([expect.objectContaining({ server: true })]);
    expect(listLinkedEnds(layout)).toEqual(listDots(layout));
    expect(listSourcesOf(layout, 'ring1')).toEqual(getInner(layout).map(({ start }) => `inner:${String(start)}`));
  });

  it('As a visitor, I see a dot just past 0 deg linked to the nearest dot just before it, around the circle', () => {
    // When
    const layout = getOrbitLayout(lightClient(0));

    // Then
    expect(findLinkFrom(layout, 'ring2', 344)).toEqual({ ring: 'ring1', start: -34 });
  });
});

function lightClient(peers: number): OrbitMode {
  return { kind: 'lightClient', peers };
}

function getInner(layout: OrbitLayout) {
  return layout.rings.find(({ ring }) => ring === 'inner')?.dots ?? [];
}

function listDots(layout: OrbitLayout): string[] {
  return layout.rings.flatMap(({ ring, dots }) => dots.map(({ start }) => `${ring}:${String(start)}`)).sort();
}

/** Each link's outer end, with the ring it links in from, which must be the ring inside its own. */
function listLinkedEnds(layout: OrbitLayout): string[] {
  const order: (OrbitRing | 'centre')[] = ['centre', ...layout.rings.map(({ ring }) => ring)];
  return layout.links
    .filter(({ from, to }) => order.indexOf(from.ring) === order.indexOf(to.ring) - 1)
    .map(({ to }) => `${to.ring}:${String(to.start)}`)
    .sort();
}

/** The ends the links into `ring` come from, each once. */
function listSourcesOf(layout: OrbitLayout, ring: OrbitRing): string[] {
  const sources = layout.links
    .filter(({ to }) => to.ring === ring)
    .map(({ from }) => `${from.ring}:${String(from.start)}`);
  return [...new Set(sources)];
}

function findLinkFrom(layout: OrbitLayout, ring: OrbitRing, start: number) {
  return layout.links.find(({ to }) => to.ring === ring && to.start === start)?.from;
}
