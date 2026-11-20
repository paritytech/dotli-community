// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { getOrbitLayout } from './getOrbitLayout.js';
import { Orbit } from './Orbit.js';

/** The orbit behind a box the size of a small landing page, which it fills. */
function Frame(): JSX.Element {
  return (
    <div style={{ position: 'relative', isolation: 'isolate', height: '480px' }}>
      <Orbit layout={getOrbitLayout()} />
    </div>
  );
}

const meta = {
  title: 'Host/Landing/Orbit',
  component: Frame,
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor using a screen reader, I am not read the orbit, which only decorates the page. */
export const Backdrop: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the orbit is hidden from assistive technology', async () => {
      await expect(canvas.getByTestId('orbit')).toHaveAttribute('aria-hidden', 'true');
    });
  },
};
