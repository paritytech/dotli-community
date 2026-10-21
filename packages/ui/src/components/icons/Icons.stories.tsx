// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import * as icons from '../../icons.js';

const ICONS = Object.entries(icons);

/** Every icon of the entry at one size, named under it. */
function Gallery(): JSX.Element {
  return (
    <div style={{ display: 'grid', 'grid-template-columns': 'repeat(auto-fill, 120px)', gap: '16px' }}>
      <For each={ICONS}>
        {([name, Icon]) => (
          <figure style={{ display: 'grid', 'justify-items': 'center', gap: '8px', margin: '0' }}>
            <Icon size={24} testId={name} />
            <figcaption style={{ 'font-size': '11px' }}>{name}</figcaption>
          </figure>
        )}
      </For>
    </div>
  );
}

const meta = {
  title: 'Primitives/Icons',
  parameters: { chrome: true },
  component: Gallery,
} satisfies Meta<typeof Gallery>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a screen reader user, I skip every icon, since each draws an svg that assistive technology ignores. */
export const All: Story = {
  play: async ({ canvas, step }) => {
    await step('Then every icon draws an svg that assistive technology skips', async () => {
      await expect(ICONS.length).toBeGreaterThan(0);
      for (const [name] of ICONS) {
        const icon = canvas.getByTestId(name);
        await expect(icon.tagName.toLowerCase()).toBe('svg');
        await expect(icon).toHaveAttribute('aria-hidden', 'true');
      }
    });
  },
};
