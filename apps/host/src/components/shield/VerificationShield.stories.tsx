// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { ReporterContext } from '@dotli/ui';
import type { Reporter } from '@dotli/ui-core';
import { createRecordingReporter } from '@dotli/ui-core/testing';
import { expect, fn, waitFor, within } from 'storybook/test';
import { expectPhone, openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import { productPill, setShield, storyShieldState } from '../../../.storybook/shield-fixtures.js';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID } from './verification-shield.js';
import { VerificationShield, type ExplainerLoader } from './VerificationShield.js';

const shown = openSurface({ surface: 'verification-tooltip' });

/** A click leaves a tooltip alone, so this hovers with trusted input, which the real `:hover` needs. */
const open: typeof shown = async ctx => {
  await ctx.step('When the mouse rests on the shield', async () => {
    const { userEvent } = await import('vitest/browser');
    const shield = document.getElementById('verification-shield');
    if (shield === null) {
      throw new Error('no verification shield');
    }
    await userEvent.hover(shield);
  });
  await shown(ctx);
  await ctx.step('And its body has loaded', async () => {
    await waitFor(() =>
      expect(document.querySelector('[data-testid="verification-tooltip-row-verified"]')).not.toBeNull(),
    );
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

function shieldButton(): HTMLElement {
  const shield = document.getElementById(VERIFICATION_SHIELD_ID);
  if (shield === null) {
    throw new Error('no verification shield');
  }
  return shield;
}

function explainer(): HTMLElement {
  const tooltip = document.getElementById(VERIFICATION_TOOLTIP_ID);
  if (tooltip === null) {
    throw new Error('no verification explainer');
  }
  return tooltip;
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

export const DescribedByTooltip: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step(
      'As a screen-reader user, the shield is a real button described by the explainer, a tooltip',
      async () => {
        // Given
        const trigger = shieldButton();
        await expect(trigger.tagName).toBe('BUTTON');
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

const chunk = { fail: true, imports: 0 };
const captured = fn().mockName('reportFailure');
const capturing: Reporter = { ...createRecordingReporter(), failure: captured };

/** The explainer chunk, gone after a deploy until `chunk.fail` is cleared. */
const loadFlakyExplainer: ExplainerLoader = async () => {
  chunk.imports += 1;
  if (chunk.fail) {
    throw new Error('chunk failed');
  }
  return import('./VerificationContent.js');
};

export const ExplainerLoadFailureRetries: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    chunk.fail = true;
    chunk.imports = 0;
    captured.mockClear();
  },
  render: () => (
    <ReporterContext value={capturing}>
      <TopbarFrame center>
        <VerificationShield state={storyShieldState} loadExplainer={loadFlakyExplainer} />
      </TopbarFrame>
    </ReporterContext>
  ),
  play: async ({ step }) => {
    await step('As a visitor after a deploy, an explainer that cannot load is reported once and hides', async () => {
      // When
      shieldButton().click();

      // Then
      await waitFor(() => expect(captured).toHaveBeenCalled());
      await expectClosed();
      await expect(captured).toHaveBeenCalledTimes(1);
      await expect(captured).toHaveBeenCalledWith(expect.any(Error), {
        flow: 'ui',
        step: 'root_render',
        tags: { root: 'tooltip:verification-tooltip' },
      });
    });
    await step('And the next showing, with the chunk back, loads it again', async () => {
      // When
      chunk.fail = false;
      await showByKey();

      // Then
      await expect(chunk.imports).toBe(2);
      await waitFor(() =>
        expect(explainer().querySelector('[data-testid="verification-tooltip-row-verified"]')).toHaveTextContent(
          'Verified',
        ),
      );
      await expect(captured).toHaveBeenCalledTimes(1);
    });
  },
};

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
        const trusted = await waitFor(() => {
          const row = explainer().querySelector('[data-testid="verification-tooltip-row-trusted"]');
          if (row === null) {
            throw new Error('no trusted row yet');
          }
          return row;
        });
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
      },
    );
  },
};

export const StateChangeKeepsOpen: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a dotli user, a state change keeps an open explainer open', async () => {
      // Given
      await showByKey();

      // When
      setShield('trusted');

      // Then
      await waitFor(() => expect(shieldButton()).toHaveAttribute('data-state', 'trusted'));
      await expectOpen();
    });
  },
};

export const GlyphPerState: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a low-vision user, each state ships its own glyph', async () => {
      // Then
      const glyphs = shieldButton().querySelectorAll('[data-testid="verification-shield-icon"]');
      await expect(glyphs).toHaveLength(2);
      const [verified, trusted] = Array.from(glyphs).map(svg =>
        Array.from(svg.querySelectorAll('path'), path => path.getAttribute('d')).join(' '),
      );
      await expect(verified).not.toBe(trusted);
    });
  },
};
