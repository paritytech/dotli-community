// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { getOrbitLayout } from './getOrbitLayout.js';
import { Orbit } from './Orbit.js';

type FrameProps = {
  /** Whether the backend reaches the network through one server rather than a light client. */
  server: boolean;
  /** The light client's peers when the story opens. */
  peers: number;
};

/** The orbit behind a box the size of a small landing page, with controls that add and drop a peer. */
function Frame(props: FrameProps): JSX.Element {
  const [peers, setPeers] = createSignal(() => props.peers);
  const layout = createMemo(() =>
    getOrbitLayout(props.server ? { kind: 'server' } : { kind: 'lightClient', peers: peers() }),
  );
  return (
    <div style={{ position: 'relative', isolation: 'isolate', height: '480px' }}>
      <Orbit layout={layout()} />
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
  args: { server: false, peers: 0 },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The inner ring's dots, in the order they joined. */
function getInnerDots(canvasElement: HTMLElement): Element[] {
  return [...(canvasElement.querySelector('[data-testid="orbit"] [data-ring="inner"]')?.children ?? [])];
}

/** Whether both lists hold the very same elements in the same order, which a structural match does not tell. */
function isSameElements(actual: readonly Element[], expected: readonly Element[]): boolean {
  return actual.length === expected.length && actual.every((element, index) => element === expected[index]);
}

/** A light client with no peers yet, whose inner ring is empty and whose first ring hangs unlinked. */
export const NoPeers: Story = {};

/** As a visitor, I watch peers join and leave, and the dots already drawn stay where they are. */
export const Peers: Story = {
  args: { peers: 6 },
  play: async ({ canvas, canvasElement, userEvent, step }) => {
    const before = getInnerDots(canvasElement);

    await step('When a peer joins', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Add a peer' }));
    });

    await step('Then a dot joins and the others keep their elements', async () => {
      const after = getInnerDots(canvasElement);
      await expect(after).toHaveLength(7);
      await expect(isSameElements(after.slice(0, 6), before)).toBe(true);
    });

    await step('When two peers leave', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Drop a peer' }));
      await userEvent.click(canvas.getByRole('button', { name: 'Drop a peer' }));
    });

    await step('Then the newest dot goes and the rest keep their elements', async () => {
      await expect(isSameElements(getInnerDots(canvasElement), before.slice(0, 5))).toBe(true);
    });
  },
};

/** A backend with no light client, which reaches the network through one server. */
export const Server: Story = {
  args: { server: true },
};
