// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { byId, byTestId } from '@dotli/ui/testing';
import { expectPhone, openSurface, TopbarFrame } from '../../testing/stories/topbar-frame.js';
import { productPill, setShield, storyShieldState } from '../../testing/stories/shield-fixtures.js';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID } from './verification-shield.js';
import { VerificationShield } from './VerificationShield.js';

const shown = openSurface({ surface: 'verification-tooltip' });

/** A click leaves a tooltip alone, so this hovers with trusted input, which the real `:hover` needs. */
const open: typeof shown = async ctx => {
  await ctx.step('When the mouse rests on the shield', async () => {
    const userEvent = await trustedInput();
    await userEvent.hover(byId('verification-shield'));
  });
  await shown(ctx);
  await ctx.step('And its body has loaded', async () => {
    await waitFor(() => byTestId('verification-tooltip-row-verified'));
  });
};

const meta = {
  title: 'Host/Shield/VerificationShield',
  component: VerificationShield,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  args: { state: storyShieldState },
  beforeEach: () => {
    productPill();
    setShield('verified');
  },
  render: () => (
    <TopbarFrame center>
      <VerificationShield state={storyShieldState} />
    </TopbarFrame>
  ),
} satisfies Meta<typeof VerificationShield>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, I rest the mouse on the shield and see how this site was loaded. */
export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
  },
};

/** As a phone visitor, I open the shield and see how this site was loaded. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
  },
};

function shieldButton(): HTMLElement {
  return byId(VERIFICATION_SHIELD_ID);
}

function explainer(): HTMLElement {
  return byId(VERIFICATION_TOOLTIP_ID);
}

async function expectOpen(): Promise<void> {
  await waitFor(() => expect(explainer()).toHaveAttribute('data-open'));
  await expect(shieldButton()).toHaveAttribute('aria-expanded', 'true');
}

async function expectClosed(): Promise<void> {
  await waitFor(() => expect(explainer()).not.toHaveAttribute('data-open'));
  await expect(shieldButton()).toHaveAttribute('aria-expanded', 'false');
}

/** Shows the explainer as Enter or Space does, with a click of `detail` 0, and waits for its body. */
async function showByKey(): Promise<void> {
  shieldButton().click();
  await expectOpen();
  await waitFor(() => expect(explainer().querySelector('[data-testid="popover-loading"]')).toBeNull());
}

/** As a screen-reader user, I reach the shield as a button described by its explainer, which shows when I press it. */
export const DescribedByTooltip: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step(
      'As a screen-reader user, the shield is a real button described by the explainer, a tooltip',
      async () => {
        // Given
        const trigger = within(document.body).getByRole('button', { name: 'Site verification' });
        await expect(trigger).toBe(shieldButton());
        await expect(trigger).toHaveAttribute('aria-describedby', VERIFICATION_TOOLTIP_ID);
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');

        // When
        await showByKey();

        // Then
        await expect(explainer()).toHaveAttribute('role', 'tooltip');
        await expect(explainer()).toHaveAttribute('popover', 'manual');
        await expect(explainer()).not.toHaveAttribute('tabindex');
      },
    );
  },
};

/** As a touch user, I tap into the app frame and the explainer hides. */
export const WindowBlurHides: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a touch user, tapping into the app frame hides the explainer', async () => {
      // Given
      await showByKey();

      // When focus leaves the host window for the cross-origin iframe
      window.dispatchEvent(new Event('blur'));

      // Then
      await expectClosed();
    });
  },
};

/** As a dotli user, I move focus elsewhere, as a modal does, and the explainer hides. */
export const FocusElsewhereHides: Story = {
  tags: ['!autodocs'],
  render: () => (
    <>
      <TopbarFrame center>
        <VerificationShield state={storyShieldState} />
      </TopbarFrame>
      <button type="button" style={{ 'margin-top': '120px' }}>
        Other
      </button>
    </>
  ),
  play: async ({ canvasElement, step }) => {
    await step('As a dotli user, focus moving elsewhere (a modal coming up takes it) hides the explainer', async () => {
      // Given
      await showByKey();
      const other = within(canvasElement).getByRole('button', { name: 'Other' });

      // When
      other.focus();

      // Then
      await expectClosed();
      await expect(other).toHaveFocus();
    });
  },
};

/** As a visitor, I see the open explainer follow how this site was loaded, and stay open as it does. */
export const FollowsStateWhileOpen: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    // No state yet, as right after the pill appears.
    productPill();
  },
  play: async ({ step }) => {
    await step(
      'As a visitor, the explainer shows only how this site was loaded, and follows the state while open',
      async () => {
        // Given
        await showByKey();
        await expect(explainer().querySelector('[data-testid^="verification-tooltip-row-"]')).toBeNull();

        // When
        setShield('trusted');

        // Then
        await waitFor(() => expect(shieldButton()).toHaveAttribute('data-state', 'trusted'));
        await expectOpen();
        const trusted = await waitFor(() => byTestId('verification-tooltip-row-trusted', explainer()));
        await expect(trusted).toHaveTextContent(
          'TrustedServed by an external RPC provider. Faster, but you rely on its answers.',
        );
        await expect(trusted.querySelector('[data-testid="verification-tooltip-icon"]')).not.toBeNull();
        await expect(explainer().querySelector('[data-testid="verification-tooltip-row-verified"]')).toBeNull();

        // When
        setShield('verified');

        // Then
        await waitFor(() => expect(shieldButton()).toHaveAttribute('data-state', 'verified'));
        await waitFor(() =>
          expect(explainer().querySelector('[data-testid="verification-tooltip-row-verified"]')).toHaveTextContent(
            'VerifiedChecked in your browser by the light client. The more secure option.',
          ),
        );
        await expect(explainer().querySelector('[data-testid="verification-tooltip-row-trusted"]')).toBeNull();
        await expectOpen();
      },
    );
  },
};
