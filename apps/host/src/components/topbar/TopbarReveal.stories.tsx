// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { expectBefore } from '@config/storybook/play';
import { TopbarReveal, type RevealActions } from './TopbarReveal.js';

const [autoHide, setAutoHide] = createSignal(false);
const [revealed, setRevealed] = createSignal(true);

/** How often the button asked to bring the bar back and focus it. */
const asked = { revealAndFocus: 0 };

/** The story's auto-hide, which marks the bar folded and brings it back focusing its first control. */
const actions: RevealActions = {
  registerRevealButton: () => () => undefined,
  reveal: () => {
    setRevealed(true);
  },
  revealAndFocus: () => {
    asked.revealAndFocus += 1;
    setRevealed(true);
    document.querySelector<HTMLElement>('[data-testid="story-topbar-home"]')?.focus();
  },
};

const meta = {
  title: 'Host/Topbar/TopbarReveal',
  component: TopbarReveal,
  args: { autoHide, shortcut: 'Alt+Shift+T', actions },
  beforeEach: () => {
    setAutoHide(false);
    setRevealed(true);
    asked.revealAndFocus = 0;
  },
  render: () => (
    <div>
      <header id="topbar" data-testid="story-topbar" data-folded={revealed() ? undefined : ''}>
        <a href="#home" data-testid="story-topbar-home" style={{ color: 'var(--text-strong)' }}>
          Home
        </a>
      </header>
      <iframe data-testid="story-app-frame" title="app" />
      <TopbarReveal autoHide={autoHide} shortcut="Alt+Shift+T" actions={actions} />
      <a href="#toast" data-testid="story-toast" style={{ color: 'var(--text-strong)' }}>
        a toast that also lives after the app
      </a>
    </div>
  ),
} satisfies Meta<typeof TopbarReveal>;

/** The bar folds away, as the auto-hide does over product content. */
function fold(): void {
  setAutoHide(true);
  setRevealed(false);
}

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * As a keyboard user, I Tab out of the app to a reveal button that brings the bar back, and pressing it asks for the
 * bar to take focus.
 */
export const RevealButtonAfterFrame: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step, userEvent }) => {
    const canvas = within(canvasElement);
    await step('Given the bar has folded away', async () => {
      fold();
      await waitFor(() => expect(canvas.getByTestId('story-topbar')).toHaveAttribute('data-folded'));
    });
    const button = canvas.getByRole('button', { name: 'Show browser bar', hidden: true });
    await step(
      'Then the reveal button sits between the app frame and the toasts, so one Tab out of the app reaches it',
      async () => {
        const frame = canvas.getByTestId('story-app-frame');
        await expectBefore(frame, button);
        await expectBefore(button, canvas.getByTestId('story-toast'));
      },
    );
    await step('When it takes focus, the bar comes back', async () => {
      button.focus();
      await waitFor(() => expect(canvas.getByTestId('story-topbar')).not.toHaveAttribute('data-folded'));
    });
    await step('When I press it, the bar is asked to come back and take focus', async () => {
      await userEvent.click(button);
      await waitFor(() => expect(asked.revealAndFocus).toBe(1));
    });
  },
};

/** As a keyboard user, I find the reveal button while the bar auto-hides and not once it stops. */
export const ShownOnlyWhileAutoHiding: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a keyboard user, the reveal button is there while the bar auto-hides, and gone once it stops',
      async () => {
        // When
        fold();

        // Then
        await waitFor(() => expect(canvas.getByRole('button', { name: 'Show browser bar' })).toBeVisible());

        // When
        setAutoHide(false);

        // Then
        await waitFor(() => expect(canvas.queryByRole('button', { name: 'Show browser bar' })).toBeNull());
      },
    );
  },
};
