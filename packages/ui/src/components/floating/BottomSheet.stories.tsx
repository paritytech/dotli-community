// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { BottomSheet } from './BottomSheet.js';
import { handOffSheet } from './SheetFrame.js';

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

/** What a hand-off left on both frames, read as `handOffSheet` returns, before any frame is drawn. */
interface HandOffMarks {
  taken: boolean;
  leaving: { open: boolean; handoff: boolean };
  coming: { open: boolean; handoff: boolean };
}

const marks = (id: string) => {
  const el = document.getElementById(id) as HTMLDialogElement;
  return { open: el.open, handoff: el.hasAttribute('data-handoff') };
};

function HandOffHarness(props: { opensNext: boolean; onMarks: (marks: HandOffMarks) => void }) {
  const [first, setFirst] = createSignal(true);
  const [second, setSecond] = createSignal(false);
  return (
    <>
      <BottomSheet open={first()} onOpenChange={setFirst} title="More" id="first-sheet" testId="first">
        <div style={{ padding: '0 16px' }}>
          <Button
            testId="hand-off"
            onClick={() => {
              const opensNext = props.opensNext;
              const taken = handOffSheet(() => {
                setFirst(false);
                if (opensNext) {
                  setSecond(true);
                }
              });
              props.onMarks({ taken, leaving: marks('first-sheet'), coming: marks('second-sheet') });
            }}
          >
            Next
          </Button>
        </div>
      </BottomSheet>
      <BottomSheet open={second()} onOpenChange={setSecond} title="Settings" id="second-sheet" testId="second">
        <p style={{ padding: '0 16px' }}>Settings</p>
      </BottomSheet>
    </>
  );
}

const onMarks = fn<(marks: HandOffMarks) => void>().mockName('onMarks');

export const HandOff: Story = {
  render: () => <HandOffHarness opensNext onMarks={onMarks} />,
  play: async ({ userEvent, step }) => {
    onMarks.mockClear();
    await step('When a sheet hands off to another as it closes', async () => {
      await waitFor(() => expect((document.getElementById('first-sheet') as HTMLDialogElement).open).toBe(true));
      await userEvent.click(body.getByTestId('hand-off'));
    });
    await step('Then by the time the hand-off returns, the leaving and the coming sheet are both marked', async () => {
      await expect(onMarks).toHaveBeenCalledWith({
        taken: true,
        leaving: { open: false, handoff: true },
        coming: { open: true, handoff: true },
      });
      await expect(document.getElementById('first-sheet')).not.toHaveAttribute('data-open');
      await expect(document.getElementById('second-sheet')).toHaveAttribute('data-open');
    });
  },
};

export const CloseWithoutHandOff: Story = {
  render: () => <HandOffHarness opensNext={false} onMarks={onMarks} />,
  play: async ({ userEvent, step }) => {
    onMarks.mockClear();
    await step('When a sheet closes in a hand-off that opens no other sheet', async () => {
      await waitFor(() => expect((document.getElementById('first-sheet') as HTMLDialogElement).open).toBe(true));
      await userEvent.click(body.getByTestId('hand-off'));
    });
    await step('Then it closed as usual, unmarked, so it slides out', async () => {
      await expect(onMarks).toHaveBeenCalledWith({
        taken: false,
        leaving: { open: false, handoff: false },
        coming: { open: false, handoff: false },
      });
    });
  },
};

const onThrow = fn().mockName('onThrow');

function ThrowingHandOffHarness() {
  const [open, setOpen] = createSignal(true);
  return (
    <BottomSheet open={open()} onOpenChange={setOpen} title="More" id="first-sheet" testId="first">
      <div style={{ padding: '0 16px' }}>
        <Button
          testId="hand-off"
          onClick={() => {
            try {
              handOffSheet(() => {
                setOpen(false);
                // The sheet is held from here, waiting on the hand-off's outcome.
                flush();
                throw new Error('the row failed');
              });
            } catch (err) {
              onThrow(err);
            }
          }}
        >
          Next
        </Button>
      </div>
    </BottomSheet>
  );
}

export const HandOffThatThrows: Story = {
  render: () => <ThrowingHandOffHarness />,
  play: async ({ userEvent, step }) => {
    onThrow.mockClear();
    const dialog = () => document.getElementById('first-sheet') as HTMLDialogElement;
    await step('Given the sheet is open', async () => {
      await waitFor(() => expect(dialog().open).toBe(true));
    });
    await step('When the hand-off it runs throws after the sheet was held', async () => {
      await userEvent.click(body.getByTestId('hand-off'));
    });
    await step('Then the sheet closed with the throw, and the page is no longer inert', async () => {
      await expect(onThrow).toHaveBeenCalledOnce();
      await expect(dialog().open).toBe(false);
      await expect(document.querySelector(':modal')).toBeNull();
    });
  },
};
