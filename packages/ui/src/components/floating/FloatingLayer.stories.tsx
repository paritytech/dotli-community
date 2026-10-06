// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { Popover } from './Popover.js';

const onOther = fn().mockName('onOther');
const onOpenChange = fn().mockName('onOpenChange');

function Harness() {
  return (
    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
      <Button
        testId="other"
        onClick={() => {
          onOther();
        }}
      >
        Other
      </Button>
      <Popover id="story-popover" title="Example" onOpenChange={onOpenChange}>
        <Popover.Trigger>
          {t => (
            <Button {...t} testId="trigger">
              Open
            </Button>
          )}
        </Popover.Trigger>
        <Popover.Content testId="story-popover-surface">
          <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
            <Button testId="inside-a">A</Button>
            <Button testId="inside-b">B</Button>
          </div>
        </Popover.Content>
      </Popover>
      <iframe
        data-testid="product"
        title="product"
        style={{ position: 'fixed', inset: '120px 0 0 0', width: '100%', height: '200px', border: '0' }}
        srcdoc="<body style='margin:0;height:100vh;background:#335'><button>product</button></body>"
      />
    </div>
  );
}

const meta = {
  title: 'Floating/Closing',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    onOther.mockClear();
    onOpenChange.mockClear();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

// The surface is portalled into the body, outside the story's canvas.
const body = within(document.body);
const surface = () => body.getByTestId('story-popover-surface');
/**
 * Trusted input, a user's: the browser's light dismiss, invokers and close
 * requests act on it only, and a press in an iframe moves focus there.
 * Loaded on use, so the stories still load in Storybook outside Vitest.
 */
const input = async () => (await import('vitest/browser')).userEvent;
const openIt = async () => {
  await (await input()).click(body.getByTestId('trigger'));
  await waitFor(() => expect(surface()).toHaveAttribute('data-open'));
};

export const ClickOutsideReachesTarget: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openIt);
    await step('When I click the Other button', async () => {
      await (await input()).click(body.getByTestId('other'));
    });
    await step('Then the popover closed and Other got the click', async () => {
      await waitFor(() => expect(surface()).not.toHaveAttribute('data-open'));
      await expect(onOther).toHaveBeenCalledOnce();
    });
  },
};

export const ClosesOnWindowBlur: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openIt);
    await step('When I click inside the product iframe', async () => {
      await (await input()).click(body.getByTestId('product'));
    });
    await step('Then the popover closed and focus stayed in the iframe', async () => {
      await waitFor(() => expect(surface()).not.toHaveAttribute('data-open'));
      await expect(document.activeElement).toBe(body.getByTestId('product'));
    });
  },
};

export const EscapeReturnsFocusToTrigger: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open and focus is on the body (as Safari leaves it)', async () => {
      await openIt();
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await step('When I press Escape', async () => {
      await (await input()).keyboard('{Escape}');
    });
    await step('Then it closed and the trigger has focus', async () => {
      await waitFor(() => expect(surface()).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('trigger')).toHaveFocus();
    });
  },
};

export const TabStaysInside: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open with focus on its first control', async () => {
      await openIt();
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I Tab twice', async () => {
      const user = await input();
      await user.tab();
      await user.tab();
    });
    await step('Then focus wrapped to the first control', async () => {
      await expect(body.getByTestId('inside-a')).toHaveFocus();
    });
  },
};

export const TriggerTogglesClosed: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openIt);
    await step('When I click the trigger again', async () => {
      await (await input()).click(body.getByTestId('trigger'));
    });
    await step('Then it is closed, once', async () => {
      await waitFor(() => expect(surface()).not.toHaveAttribute('data-open'));
      await expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    });
  },
};

export const ClosesWhenAModalOpens: Story = {
  play: async ({ step }) => {
    await step('Given the popover is open', openIt);
    await step('When a modal dialog opens', () => {
      const d = document.createElement('dialog');
      document.body.append(d);
      d.showModal();
      d.close();
      d.remove();
    });
    await step('Then the popover closed', async () => {
      await waitFor(() => expect(surface()).not.toHaveAttribute('data-open'));
    });
  },
};
