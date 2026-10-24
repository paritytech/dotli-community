// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { Tooltip } from './Tooltip.js';

// The tooltip is portalled into the body, outside the story's canvas.
const body = within(document.body);

function Harness() {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <button ref={setTrigger} type="button" data-testid="tip-trigger">
        Shield
      </button>
      <Tooltip id="story-tip" trigger={trigger()}>
        <p style={{ margin: 0, padding: '12px' }} data-testid="tip-text">
          Loaded through a light client.
        </p>
      </Tooltip>
      <button type="button" data-testid="elsewhere">
        Elsewhere
      </button>
    </div>
  );
}

const meta = {
  title: 'Floating/Tooltip',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '200px' } } },
  tags: ['!autodocs'],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Trusted input, so `:focus-visible` tells a real Tab from a click. Imported lazily so Storybook loads the stories
 * outside Vitest.
 */
const input = async () => (await import('vitest/browser')).userEvent;

/** The browser's touch sequence as observed by the tooltip, without privileged DevTools access. */
const tap = (el: Element) => {
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      isPrimary: true,
    }),
  );
  el.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      isPrimary: true,
    }),
  );
  el.dispatchEvent(
    new PointerEvent('click', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      isPrimary: true,
      detail: 1,
    }),
  );
};

const tip = (): HTMLElement => {
  const el = document.getElementById('story-tip');
  if (el === null) {
    throw new Error('No #story-tip');
  }
  return el;
};
const trigger = () => body.getByTestId('tip-trigger');

export const ShowsOnHover: Story = {
  play: async ({ step }) => {
    await step('When the mouse rests on the trigger', async () => {
      await (await input()).hover(trigger());
    });
    await step('Then the tooltip shows, describing the trigger, and focus stays put', async () => {
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
      await expect(tip()).toHaveAttribute('role', 'tooltip');
      await expect(tip()).toHaveAttribute('popover', 'manual');
      await expect(trigger()).toHaveAttribute('aria-describedby', 'story-tip');
      await expect(trigger()).toHaveAttribute('aria-expanded', 'true');
      await expect(trigger()).not.toHaveFocus();
    });
    await step('When the mouse moves onto the tooltip', async () => {
      await (await input()).hover(body.getByTestId('tip-text'));
    });
    await step('Then it stays', async () => {
      await expect(tip()).toHaveAttribute('data-open');
    });
    await step('When the mouse leaves both', async () => {
      await (await input()).hover(body.getByTestId('elsewhere'));
    });
    await step('Then it hides', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
      await expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

export const ShowsOnKeyboardFocusAndEscapeHides: Story = {
  play: async ({ step }) => {
    await step('When I Tab to the trigger', async () => {
      await (await input()).tab();
      await expect(trigger()).toHaveFocus();
    });
    await step('Then the tooltip shows at once', async () => {
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
    });
    await step('When I press Escape', async () => {
      await (await input()).keyboard('{Escape}');
    });
    await step('Then it hides and focus stays on the trigger', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
      await expect(trigger()).toHaveFocus();
    });
    await step('When I press Enter on the trigger', async () => {
      await (await input()).keyboard('{Enter}');
    });
    await step('Then it shows again', async () => {
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
    });
    await step('When I Tab on', async () => {
      await (await input()).tab();
      await expect(body.getByTestId('elsewhere')).toHaveFocus();
    });
    await step('Then it hides', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
    });
  },
};

export const TapToggles: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('When I tap the trigger', () => {
      tap(trigger());
    });
    await step('Then the tooltip shows', async () => {
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
    });
    await step('When I tap elsewhere', () => {
      tap(body.getByTestId('elsewhere'));
    });
    await step('Then it hides', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
    });
    await step('When I tap the trigger twice', async () => {
      tap(trigger());
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
      tap(trigger());
    });
    await step('Then the second tap hid it', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
    });
  },
};
