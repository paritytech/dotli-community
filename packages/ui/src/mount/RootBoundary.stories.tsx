// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { RootBoundary } from './root-boundary.js';

function Throws(): JSX.Element {
  throw new Error('view broke');
}

const meta = {
  title: 'Primitives/RootBoundary',
  component: RootBoundary,
  args: { root: 'story', onBroken: fn(), children: undefined },
} satisfies Meta<typeof RootBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BrokenRenderNothing: Story = {
  render: args => (
    <div data-testid="root-holder">
      <RootBoundary root={args.root} onBroken={args.onBroken}>
        <Throws />
      </RootBoundary>
    </div>
  ),
  play: async ({ args, canvas, step }) => {
    await step('Then the broken view is replaced by nothing, and its stand-in runs once', async () => {
      await waitFor(() => expect(args.onBroken).toHaveBeenCalledOnce());
      await expect(canvas.getByTestId('root-holder')).toBeEmptyDOMElement();
    });
  },
};

export const HealthyRendersItsChildren: Story = {
  render: args => (
    <RootBoundary root={args.root} onBroken={args.onBroken}>
      <p data-testid="root-content">Shown</p>
    </RootBoundary>
  ),
  play: async ({ args, canvas, step }) => {
    await step('Then the children show and no stand-in runs', async () => {
      await expect(canvas.getByTestId('root-content')).toHaveTextContent('Shown');
      await expect(args.onBroken).not.toHaveBeenCalled();
    });
  },
};
