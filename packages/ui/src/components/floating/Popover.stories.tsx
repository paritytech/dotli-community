// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { Popover } from './Popover.js';

const onOpenChange = fn().mockName('onOpenChange');
const onElse = fn().mockName('onElse');
// The surface is portalled into the body, outside the story's canvas.
const body = within(document.body);

const Failing = lazy(() => Promise.reject(new Error('chunk')));

function Harness(props: { content?: 'buttons' | 'failing'; opensElse?: boolean }) {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const content = (): JSX.Element =>
    props.content === 'failing' ? (
      <Failing />
    ) : (
      <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
        <Button testId="inside-a">A</Button>
        <Button testId="inside-b">B</Button>
      </div>
    );
  return (
    <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
      <Button
        ref={setTrigger}
        testId="trigger"
        onClick={() => {
          if (props.opensElse === true) {
            onElse();
          }
        }}
      >
        Open
      </Button>
      {/* With `opensElse`, as AuthButton while not connected: the button is not the trigger, its click starts something else. */}
      <Popover
        id="story-popover"
        title="Example"
        trigger={props.opensElse === true ? undefined : trigger()}
        onOpenChange={onOpenChange}
        testId="story-popover-surface"
      >
        {content()}
      </Popover>
    </div>
  );
}

const meta = {
  title: 'Floating/Popover',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    onOpenChange.mockClear();
    onElse.mockClear();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Trusted input, a user's: the browser's invokers act on it only. Loaded on
 * use, so the stories still load in Storybook outside Vitest.
 */
const input = async () => (await import('vitest/browser')).userEvent;
const press = async (testId: string) => {
  await (await input()).click(body.getByTestId(testId));
};

export const Open: Story = {
  play: async ({ step }) => {
    await step('When I press the button', () => press('trigger'));
    await step('Then the anchored dialog is open, focus on its first control', async () => {
      const surface = body.getByTestId('story-popover-surface');
      await waitFor(() => expect(surface).toHaveAttribute('data-open'));
      await expect(surface).toHaveAttribute('role', 'dialog');
      await expect(surface).toHaveAccessibleName('Example');
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
  },
};

export const PhoneSheet: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('When I press the button on a phone', () => press('trigger'));
    await step('Then a bottom sheet titled Example opens, and no anchored layer', async () => {
      await waitFor(() => expect(body.getByTestId('popover-sheet-title')).toHaveTextContent('Example'));
      const sheet = document.getElementById('story-popover') as HTMLDialogElement;
      await expect(sheet.open).toBe(true);
      await expect(document.querySelectorAll(':popover-open')).toHaveLength(0);
      await expect(onOpenChange.mock.calls).toEqual([[true]]);
    });
    await step('And focus is on its first control', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
  },
};

export const PhoneClosesReturnFocus: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    const settled = async (calls: boolean[][]) => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual(calls));
      await waitFor(() => expect((document.getElementById('story-popover') as HTMLDialogElement).open).toBe(false));
      await waitFor(() => expect(body.getByTestId('trigger')).toHaveFocus());
      // Both the sheet's restore and the popover's land on the trigger, and nothing moves it after.
      await new Promise(resolve => requestAnimationFrame(resolve));
      await expect(body.getByTestId('trigger')).toHaveFocus();
    };
    await step('Given the sheet is open', () => press('trigger'));
    await step('When I press its close button', () => press('popover-sheet-close'));
    await step('Then it closed once and the trigger has focus', () => settled([[true], [false]]));
    await step('Given the sheet is open again', () => press('trigger'));
    await step('When I press Escape', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
      await (await input()).keyboard('{Escape}');
    });
    await step('Then it closed once more and the trigger has focus', () => settled([[true], [false], [true], [false]]));
  },
};

export const TriggerWithoutTargetOpensNothing: Story = {
  args: { opensElse: true },
  play: async ({ step }) => {
    await step('When I press a button the popover does not hold as its trigger', () => press('trigger'));
    await step('Then its own click ran and the popover stayed closed', async () => {
      await expect(onElse).toHaveBeenCalledOnce();
      await expect(body.getByTestId('trigger')).not.toHaveAttribute('popovertarget');
      await new Promise(resolve => requestAnimationFrame(resolve));
      await expect(onOpenChange).not.toHaveBeenCalled();
      await expect(document.getElementById('story-popover')?.hasAttribute('data-open') ?? false).toBe(false);
    });
  },
};

export const LazyContentFails: Story = {
  args: { content: 'failing' },
  play: async ({ step }) => {
    await step('When I open the popover whose content cannot load', () => press('trigger'));
    await step('Then it opened, and closed again', async () => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false]]));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false');
    });
    await step('When I open it again at once, while the failed content is still fading out', () => press('trigger'));
    await step('Then the content loaded afresh, failed again and closed again', async () => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false], [true], [false]]));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
    });
  },
};
