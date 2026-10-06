// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { BottomSheet } from './BottomSheet.js';

const onOpenChange = fn().mockName('onOpenChange');
// The sheet is portalled into the body, outside the story's canvas.
const body = within(document.body);

function Harness(props: { initiallyOpen?: boolean }) {
  // The initial state only: later arg changes do not reopen it.
  const [open, setOpen] = createSignal(untrack(() => props.initiallyOpen === true));
  return (
    <>
      <Button testId="opener" onClick={() => setOpen(true)}>
        Open sheet
      </Button>
      <BottomSheet
        open={open()}
        onOpenChange={next => {
          onOpenChange(next);
          setOpen(next);
        }}
        title="Settings"
        id="story-sheet"
        testId="story-sheet"
      >
        <div style={{ padding: '0 16px' }}>
          <Button testId="first">First</Button>
          <Button testId="second">Second</Button>
        </div>
      </BottomSheet>
    </>
  );
}

const meta = {
  title: 'Floating/BottomSheet',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '520px' } } },
  globals: { viewport: { value: 'phone', isRotated: false } },
  tags: ['!autodocs'],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: { initiallyOpen: true },
  play: async ({ step }) => {
    await step('Then the sheet is a modal dialog titled Settings', async () => {
      const dialog = document.getElementById('story-sheet') as HTMLDialogElement;
      await waitFor(() => expect(dialog.open).toBe(true));
      await expect(dialog.matches(':modal')).toBe(true);
      await expect(document.querySelector('[data-testid="story-sheet-sheet-title"]')).toHaveTextContent('Settings');
    });
  },
};

export const EscapeClosesAndRestoresFocus: Story = {
  play: async ({ canvas, userEvent, step }) => {
    onOpenChange.mockClear();
    await step('Given I opened the sheet from its button', async () => {
      await userEvent.click(canvas.getByTestId('opener'));
      await waitFor(() => expect((document.getElementById('story-sheet') as HTMLDialogElement).open).toBe(true));
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then it reports closed and focus is back on the button', async () => {
      await expect(onOpenChange).toHaveBeenLastCalledWith(false);
      await waitFor(() => expect(canvas.getByTestId('opener')).toHaveFocus());
    });
  },
};

export const ScrimClosesIt: Story = {
  args: { initiallyOpen: true },
  play: async ({ userEvent, step }) => {
    onOpenChange.mockClear();
    await step('When I press the scrim above the sheet', async () => {
      const scrim = body.getByTestId('story-sheet-scrim');
      await waitFor(() => expect(scrim).toBeVisible());
      await userEvent.pointer({ keys: '[MouseLeft]', target: scrim, coords: { clientX: 10, clientY: 10 } });
    });
    await step('Then it reports closed', async () => {
      await expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
  },
};

export const TabStaysInside: Story = {
  args: { initiallyOpen: true },
  play: async ({ userEvent, step }) => {
    const close = () => body.getByTestId('story-sheet-sheet-close');
    await step('Given focus is on the last control', () => {
      body.getByTestId('second').focus();
    });
    await step('When I press Tab', async () => {
      await userEvent.tab();
    });
    await step('Then focus wraps to the head close button, still in the sheet', async () => {
      await expect(close()).toHaveFocus();
    });
  },
};
