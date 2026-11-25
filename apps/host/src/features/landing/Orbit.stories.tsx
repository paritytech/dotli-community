// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { anchorOrbitLayout } from './anchorOrbitLayout.js';
import { getOrbitLayout, type OrbitLayout } from './getOrbitLayout.js';
import { Orbit } from './Orbit.js';

type FrameProps = {
  /** Whether the backend reaches the network through one trusted provider rather than a light client. */
  trustedProvider: boolean;
  /** The light client's peers when the story opens. */
  peers: number;
  /** What turns each dot off its even place. */
  seed: number;
  /** How far across the viewport the floor is shifted, from -1 at its left edge to 1 at its right. */
  shiftX: number;
  /** How far up the viewport the floor is shifted, from -1 at its top to 1 at its foot. */
  shiftY: number;
};

/** The orbit behind a box the size of a small landing page, with controls that add and drop a peer. */
function Frame(props: FrameProps): JSX.Element {
  const [peers, setPeers] = createSignal(() => props.peers);
  // So adding or dropping a peer keeps the latest peer that stays in place.
  const layout = createMemo((previous?: OrbitLayout) =>
    anchorOrbitLayout(
      previous ?? null,
      getOrbitLayout(
        props.trustedProvider ? { kind: 'trustedProvider' } : { kind: 'lightClient', peers: peers() },
        props.seed,
      ),
    ),
  );
  return (
    <div style={{ position: 'relative', isolation: 'isolate', height: '480px' }}>
      <Orbit layout={layout()} shiftX={props.shiftX} shiftY={props.shiftY} />
      <button type="button" onClick={() => setPeers(count => count + 1)}>
        Add a peer
      </button>
      <button type="button" onClick={() => setPeers(count => Math.max(count - 1, 0))}>
        Drop a peer
      </button>
    </div>
  );
}

const meta = {
  title: 'Host/Landing/Orbit',
  component: Frame,
  args: { trustedProvider: false, peers: 0, seed: 1, shiftX: 0, shiftY: 0 },
  argTypes: {
    shiftX: { control: { type: 'range', min: -1, max: 1, step: 0.1 } },
    shiftY: { control: { type: 'range', min: -1, max: 1, step: 0.1 } },
  },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The light client's peers. */
function getPeerDots(canvasElement: HTMLElement): Element[] {
  return [...canvasElement.querySelectorAll('[data-testid="orbit"] [data-kind="peer"]')];
}

/** Whether both lists hold the very same elements in the same order, which a structural match does not tell. */
function isSameElements(actual: readonly Element[], expected: readonly Element[]): boolean {
  return actual.length === expected.length && actual.every((element, index) => element === expected[index]);
}

/** Every dot and link the orbit draws. */
function getJoined(canvasElement: HTMLElement): Element[] {
  return [...canvasElement.querySelectorAll('[data-testid="orbit"] :is([data-kind], [data-link])')];
}

/** How a dot or link joined the orbit: onto an empty floor, or onto one that held dots. */
function getJoin(element: Element): string | null {
  return element.getAttribute('data-join');
}

/**
 * A light client with no peers yet: only the rings and the centre.
 *
 * As a visitor, I see the first peer and its tree join an empty floor, and a later peer's dots and links join a floor
 * that holds dots.
 */
export const NoPeers: Story = {
  play: async ({ canvas, canvasElement, userEvent, step }) => {
    await step('When the first peer joins', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Add a peer' }));
    });

    const first = getJoined(canvasElement);
    await step('Then its dots and links join an empty floor', async () => {
      await expect(first).not.toHaveLength(0);
      await expect(first.map(getJoin)).toEqual(first.map(() => 'first'));
    });

    await step('When a second peer joins', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Add a peer' }));
    });

    await step('Then its dots and links join a floor with dots, and the first ones keep their join', async () => {
      const later = getJoined(canvasElement).filter(element => !first.includes(element));
      await expect(later).not.toHaveLength(0);
      await expect(later.map(getJoin)).toEqual(later.map(() => 'later'));
      const kept = first.filter(element => element.isConnected);
      await expect(kept).not.toHaveLength(0);
      await expect(kept.map(getJoin)).toEqual(kept.map(() => 'first'));
    });
  },
};

/** As a visitor, I watch peers join and leave, and the peers that stay keep their elements while they move. */
export const Peers: Story = {
  args: { peers: 6 },
  play: async ({ canvas, canvasElement, userEvent, step }) => {
    const peersBefore = getPeerDots(canvasElement);

    await step('When a peer joins', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Add a peer' }));
    });

    await step('Then a peer joins and every peer drawn before keeps its element', async () => {
      await expect(getPeerDots(canvasElement)).toHaveLength(7);
      await expect(isSameElements(getPeerDots(canvasElement).slice(0, 6), peersBefore)).toBe(true);
    });

    await step('When two peers leave', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Drop a peer' }));
      await userEvent.click(canvas.getByRole('button', { name: 'Drop a peer' }));
    });

    await step('Then the newest peers go and every peer left keeps its element', async () => {
      await expect(isSameElements(getPeerDots(canvasElement), peersBefore.slice(0, 5))).toBe(true);
    });
  },
};

/** Peers on four rings, spread evenly around the circle together rather than ring by ring. */
export const ManyPeers: Story = {
  args: { peers: 20 },
};

/**
 * A backend with no light client, which reaches the network through one trusted provider: one small tree from the trusted provider among
 * loose dots linked to nothing.
 */
export const TrustedProvider: Story = {
  args: { trustedProvider: true },
};
