// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { Tooltip } from './Tooltip.js';

// The tooltip is portalled into the body, outside the story's canvas.
const body = within(document.body);

function Harness() {
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <Tooltip id="story-tip">
        <Tooltip.Trigger>
          {t => (
            <button {...t} type="button" data-testid="tip-trigger">
              Shield
            </button>
          )}
        </Tooltip.Trigger>
        <Tooltip.Content>
          <p style={{ margin: '12px' }} data-testid="tip-text">
            Loaded through a light client.
          </p>
        </Tooltip.Content>
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
 * Trusted input, a user's: a real mouse over the trigger, and a real Tab,
 * which `:focus-visible` tells from a click. Loaded on use, so the stories
 * still load in Storybook outside Vitest.
 */
const input = async () => (await import('vitest/browser')).userEvent;

/**
 * A real tap (Chromium's own gesture, through the DevTools protocol), at the
 * centre of `el` in the top page's coordinates: the test runs in a frame,
 * which the runner may scale. A scripted touch focuses as a script does,
 * which `:focus-visible` takes for a keyboard's.
 */
const tap = async (el: Element) => {
  const { cdp } = await import('vitest/browser');
  const box = el.getBoundingClientRect();
  let x = box.left + box.width / 2;
  let y = box.top + box.height / 2;
  let win: Window = window;
  while (win.frameElement !== null) {
    const frame = win.frameElement.getBoundingClientRect();
    const scale = frame.width / win.innerWidth;
    x = frame.left + x * scale;
    y = frame.top + y * scale;
    win = win.parent;
  }
  await cdp().send('Input.synthesizeTapGesture', { x, y, gestureSourceType: 'touch' });
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
    await step('When I tap the trigger', async () => {
      await tap(trigger());
    });
    await step('Then the tooltip shows', async () => {
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
    });
    await step('When I tap elsewhere', async () => {
      await tap(body.getByTestId('elsewhere'));
    });
    await step('Then it hides', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
    });
    await step('When I tap the trigger twice', async () => {
      await tap(trigger());
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
      await tap(trigger());
    });
    await step('Then the second tap hid it', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
    });
  },
};
