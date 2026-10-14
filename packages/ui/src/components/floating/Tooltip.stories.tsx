// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { byId } from '@dotli/ui/testing';
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
 * A real tap through the DevTools protocol, in top-page coordinates since the runner may scale the test's frame.
 * A scripted touch would read as keyboard focus to `:focus-visible`, and `Input.synthesizeTapGesture` never
 * reaches the page on Linux CI.
 */
const tap = async (el: Element) => {
  const { cdp } = await import('vitest/browser');
  const session = cdp();
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
  // Chromium turns touches into a click only while touch is emulated.
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
};

const tip = (): HTMLElement => byId('story-tip');
const trigger = () => body.getByTestId('tip-trigger');

/** As a mouse user, I rest on the trigger and the tooltip shows and stays while I am on it, then hides when I leave. */
export const ShowsOnHover: Story = {
  play: async ({ step }) => {
    await step('When the mouse rests on the trigger', async () => {
      await (await trustedInput()).hover(trigger());
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
      await (await trustedInput()).hover(body.getByTestId('tip-text'));
    });
    await step('Then it stays', async () => {
      await expect(tip()).toHaveAttribute('data-open');
    });
    await step('When the mouse leaves both', async () => {
      await (await trustedInput()).hover(body.getByTestId('elsewhere'));
    });
    await step('Then it hides', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
      await expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

/** As a keyboard user, I tab to the trigger and the tooltip shows, and Escape hides it while focus stays. */
export const ShowsOnKeyboardFocusAndEscapeHides: Story = {
  play: async ({ step }) => {
    await step('When I Tab to the trigger', async () => {
      await (await trustedInput()).tab();
      await expect(trigger()).toHaveFocus();
    });
    await step('Then the tooltip shows at once', async () => {
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
    });
    await step('When I press Escape', async () => {
      await (await trustedInput()).keyboard('{Escape}');
    });
    await step('Then it hides and focus stays on the trigger', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
      await expect(trigger()).toHaveFocus();
    });
    await step('When I press Enter on the trigger', async () => {
      await (await trustedInput()).keyboard('{Enter}');
    });
    await step('Then it shows again', async () => {
      await waitFor(() => expect(tip()).toHaveAttribute('data-open'));
    });
    await step('When I Tab on', async () => {
      await (await trustedInput()).tab();
      await expect(body.getByTestId('elsewhere')).toHaveFocus();
    });
    await step('Then it hides', async () => {
      await waitFor(() => expect(tip()).not.toHaveAttribute('data-open'));
    });
  },
};

/** As a phone user, I tap the trigger to show the tooltip and tap elsewhere or on it again to hide it. */
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
