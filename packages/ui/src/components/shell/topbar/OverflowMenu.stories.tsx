// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { TopbarFrame, expectPhone, openSurface } from '../../../../.storybook/shell-fixtures.js';
import { resetAllStoresForTests } from '../../../state/create-store.js';
import { setProductLoaded } from '../../../state/product.js';
import { initSettingsStore } from '../../../state/settings.js';
import { ChainsPopover } from '../ChainsPopover.js';
import { PermissionsPopover } from '../PermissionsPopover.js';
import { SettingsPopover } from '../SettingsPopover.js';
import { OverflowMenu } from './OverflowMenu.js';

const open = openSurface({ trigger: 'more-button', surface: 'more-popover' });

function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`No ${selector}`);
  }
  return found;
}

const meta = {
  title: 'Shell/More',
  component: OverflowMenu,
  // The bar's own group builds the rows and the button ref, so the render ignores these.
  args: { rows: [], buttonRef: () => undefined },
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    setProductLoaded('Example', 'example');
    initSettingsStore();
    return resetAllStoresForTests;
  },
  render: () => (
    <TopbarFrame room={40}>
      <ChainsPopover />
      <PermissionsPopover />
      <SettingsPopover />
    </TopbarFrame>
  ),
} satisfies Meta<typeof OverflowMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
  },
};

export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
  },
};

export const RowOpensCollapsedPopover: Story = {
  tags: ['!autodocs'],
  play: async ({ userEvent, step }) => {
    await step('Given More is open', async () => {
      await userEvent.click(el('#more-button'));
      await waitFor(() => expect(document.getElementById('more-popover')).toHaveAttribute('data-open'));
    });
    await step('When I choose the Settings row', async () => {
      await userEvent.click(el('#more-popover [data-item="settings"]'));
    });
    await step('Then Settings is open under the topbar and More is closed', async () => {
      await waitFor(() => expect(document.getElementById('mode-popover')).toHaveAttribute('data-open'));
      await expect(document.getElementById('more-popover')).not.toHaveAttribute('data-open');
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then focus is on More, since the Settings button is collapsed', async () => {
      await waitFor(() => expect(document.getElementById('more-button')).toHaveFocus());
    });
  },
};
