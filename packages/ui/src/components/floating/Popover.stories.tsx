// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { Popover } from './Popover.js';

const Failing = lazy(() => Promise.reject(new Error('chunk')));

function Harness(props: {
  content?: 'buttons' | 'failing';
  handOver?: boolean;
  onOpenChange: (open: boolean) => void;
  onElse: () => void;
}) {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const [held, setHeld] = createSignal(true);
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
    <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
      {/* With `handOver` the popover lets the button go, as AuthButton does when the session drops. */}
      {props.handOver === true ? (
        <Button
          testId="let-go"
          onClick={() => {
            setHeld(false);
          }}
        >
          Let go
        </Button>
      ) : null}
      <Button
        ref={setTrigger}
        testId="trigger"
        onClick={() => {
          if (!held()) {
            props.onElse();
          }
        }}
      >
        Open
      </Button>
      <Popover
        id="story-popover"
        title="Example"
        trigger={held() ? trigger() : undefined}
        onOpenChange={props.onOpenChange}
      >
        {content()}
      </Popover>
    </div>
  );
}

const meta = {
  title: 'Floating/Popover',
  component: Harness,
  args: { onOpenChange: fn<(open: boolean) => void>(), onElse: fn<() => void>() },
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  tags: ['!autodocs'],
  beforeEach: ({ args }) => {
    // Each story owns its callbacks, including late lazy-load completions from a disposed story.
    args.onOpenChange = fn<(open: boolean) => void>();
    args.onElse = fn<() => void>();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Trusted input, which the browser's invokers require. Imported lazily so Storybook loads the stories outside Vitest.
 */
const input = async () => (await import('vitest/browser')).userEvent;
const press = async (element: HTMLElement) => {
  await (await input()).click(element);
};

export const Open: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ args, canvas, canvasElement, step }) => {
    // Only the surface is portalled; resolve its document for this story rather than at module import.
    const body = within(canvasElement.ownerDocument.body);
    await step('When I press the button', () => press(canvas.getByTestId('trigger')));
    await step('Then the anchored dialog is open, focus on its first control', async () => {
      // The first trusted click can beat the idle preload of the surface chunk.
      const surface = await body.findByRole('dialog', { name: 'Example' });
      await waitFor(() => expect(surface).toBeVisible());
      await expect(canvas.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(within(surface).getByTestId('inside-a')).toHaveFocus());
      await expect(args.onOpenChange).toHaveBeenCalledOnce();
      await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    });
  },
};

export const PhoneSheet: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ args, canvas, canvasElement, step }) => {
    const body = within(canvasElement.ownerDocument.body);
    await step('When I press the button on a phone', () => press(canvas.getByTestId('trigger')));
    await step('Then a bottom sheet titled Example opens', async () => {
      const sheet = await body.findByRole('dialog', { name: 'Example' });
      await waitFor(() => expect(sheet).toBeVisible());
      await expect(within(sheet).getByTestId('popover-sheet-close')).toBeVisible();
      await expect(body.getAllByRole('dialog', { name: 'Example' })).toHaveLength(1);
      await expect(canvas.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(within(sheet).getByTestId('inside-a')).toHaveFocus());
      await expect(args.onOpenChange).toHaveBeenCalledOnce();
      await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    });
  },
};

export const PhoneClosesReturnFocus: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ args, canvas, canvasElement, step }) => {
    const body = within(canvasElement.ownerDocument.body);
    const settled = async (count: number) => {
      await waitFor(() => expect(args.onOpenChange).toHaveBeenCalledTimes(count));
      await expect(args.onOpenChange).toHaveBeenNthCalledWith(count - 1, true);
      await expect(args.onOpenChange).toHaveBeenNthCalledWith(count, false);
      await waitFor(() => expect(body.queryByRole('dialog', { name: 'Example' })).not.toBeInTheDocument());
      await waitFor(() => expect(canvas.getByTestId('trigger')).toHaveFocus());
      // Both the sheet's restore and the popover's land on the trigger, and nothing moves it after.
      const { promise, resolve } = Promise.withResolvers<number>();
      requestAnimationFrame(resolve);
      await promise;
      await expect(canvas.getByTestId('trigger')).toHaveFocus();
    };
    await step('Given the sheet is open', async () => {
      await press(canvas.getByTestId('trigger'));
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
    await step('When I press its close button', () => press(body.getByTestId('popover-sheet-close')));
    await step('Then it closed once and the trigger has focus', () => settled(2));
    await step('Given the sheet is open again', () => press(canvas.getByTestId('trigger')));
    await step('When I press Escape', async () => {
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
      await (await input()).keyboard('{Escape}');
    });
    await step('Then it closed once more and the trigger has focus', () => settled(4));
  },
};

export const ReleasedTriggerOpensNothing: Story = {
  args: { handOver: true },
  play: async ({ args, canvas, canvasElement, step }) => {
    const body = within(canvasElement.ownerDocument.body);
    const trigger = () => canvas.getByTestId('trigger');
    await step('Given the popover holds the button as its trigger', async () => {
      await waitFor(() => expect(trigger()).toHaveAttribute('aria-expanded', 'false'));
    });
    await step('When the popover lets it go', () => press(canvas.getByTestId('let-go')));
    await step('And I press the button', () => press(trigger()));
    await step('Then its own click ran and nothing opened', async () => {
      await expect(args.onElse).toHaveBeenCalledOnce();
      const { promise, resolve } = Promise.withResolvers<number>();
      requestAnimationFrame(resolve);
      await promise;
      await expect(args.onOpenChange).not.toHaveBeenCalled();
      await expect(body.queryByRole('dialog', { name: 'Example' })).not.toBeInTheDocument();
    });
    await step('And the button kept its ARIA', async () => {
      await expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(trigger()).toHaveAttribute('aria-controls', 'story-popover');
      await expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

export const LazyContentFails: Story = {
  args: { content: 'failing' },
  play: async ({ args, canvas, step }) => {
    await step('When I open the popover whose content cannot load', () => press(canvas.getByTestId('trigger')));
    await step('Then it opened, and closed again', async () => {
      await waitFor(() => expect(args.onOpenChange).toHaveBeenCalledTimes(2));
      await expect(args.onOpenChange).toHaveBeenNthCalledWith(1, true);
      await expect(args.onOpenChange).toHaveBeenNthCalledWith(2, false);
      await waitFor(() => expect(canvas.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false'));
    });
    await step('When I open it again at once, while the failed content is still fading out', () =>
      press(canvas.getByTestId('trigger')),
    );
    await step('Then the content loaded afresh, failed again and closed again', async () => {
      await waitFor(() => expect(args.onOpenChange).toHaveBeenCalledTimes(4));
      await expect(args.onOpenChange).toHaveBeenNthCalledWith(3, true);
      await expect(args.onOpenChange).toHaveBeenNthCalledWith(4, false);
      await waitFor(() => expect(canvas.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false'));
    });
  },
};
