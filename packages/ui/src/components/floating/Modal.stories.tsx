// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { TrashIcon } from '../icons/TrashIcon.js';
import { Button } from '../primitives/Button.js';
import { Callout } from '../primitives/Well.js';
import { Modal } from './Modal.js';

const onOpenChange = fn().mockName('onOpenChange');
// The modal is portalled into the body, outside the story's canvas.
const body = within(document.body);

function Harness() {
  const [open, setOpen] = createSignal(true);
  let input: HTMLInputElement | undefined;
  return (
    <Modal
      open={open()}
      onOpenChange={next => {
        onOpenChange(next);
        setOpen(next);
      }}
      title="Clear site data"
      labelledBy="story-modal-title"
      initialFocus={() => input}
      testId="story-modal"
    >
      <Modal.Head titleId="story-modal-title" title="Clear site data" icon={TrashIcon} />
      <Modal.Body>
        <Callout>The site forgets its settings and signs you out.</Callout>
        <input
          ref={el => {
            input = el;
          }}
          type="password"
          aria-label="Password"
          placeholder="Password"
          data-testid="story-password"
        />
      </Modal.Body>
      <Modal.Actions>
        <Button variant="secondary" block>
          Cancel
        </Button>
        <Button variant="danger" block>
          Clear
        </Button>
      </Modal.Actions>
    </Modal>
  );
}

const meta = {
  title: 'Floating/Modal',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '520px' } } },
  tags: ['!autodocs'],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a keyboard user, I tab past the last answer in the card and focus wraps inside it, and Escape reports it closed once. */
export const Desktop: Story = {
  play: async ({ userEvent, step }) => {
    onOpenChange.mockClear();
    await step('Given focus starts in the password field', async () => {
      await waitFor(() => expect(body.getByTestId('story-password')).toHaveFocus());
    });
    await step('When I Tab past the last answer', async () => {
      await userEvent.tab();
      await userEvent.tab();
      await userEvent.tab();
    });
    await step('Then focus wrapped inside the card', async () => {
      await expect(body.getByTestId('story-modal').contains(document.activeElement)).toBe(true);
      await expect(body.getByTestId('story-password')).toHaveFocus();
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then it reports closed once', async () => {
      await expect(onOpenChange).toHaveBeenCalledOnce();
      await expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  },
};

/** As a phone user, I see the dialog as a sheet with its title. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('Then it is a sheet titled Clear site data', async () => {
      await waitFor(() => expect(body.getByTestId('story-modal-sheet-title')).toHaveTextContent('Clear site data'));
    });
  },
};

/** As a dotli user, I resize the window across the phone breakpoint and the dialog keeps my typed value and focus. */
export const SwitchesFormKeepingContent: Story = {
  play: async ({ userEvent, step }) => {
    const input = () => body.getByTestId<HTMLInputElement>('story-password');
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    try {
      await step('Given I typed a password in the card', async () => {
        await waitFor(() => expect(input()).toHaveFocus());
        await userEvent.type(input(), 'hunter2');
      });
      await step('When the window narrows to a phone', async () => {
        await page.viewport(390, 844);
      });
      await step('Then the sheet shows the same field, value and focus', async () => {
        await waitFor(() => expect(body.getByTestId('story-modal-sheet-head')).toBeInTheDocument());
        await expect(input().value).toBe('hunter2');
        await expect(input()).toHaveFocus();
      });
      await step('When the window widens back to a desktop', async () => {
        await page.viewport(wide.width, wide.height);
      });
      await step('Then the card shows the same field, value and focus', async () => {
        await waitFor(() => expect(body.queryByTestId('story-modal-sheet-head')).not.toBeInTheDocument());
        await expect(input().value).toBe('hunter2');
        await expect(input()).toHaveFocus();
      });
    } finally {
      // The next story must not inherit the phone.
      await page.viewport(wide.width, wide.height);
    }
  },
};

const [swapOpen, setSwapOpen] = createSignal(false);
const [step, setStep] = createSignal(1);

/** A modal mounted closed whose content swaps in place from step to step, and its trigger. */
function SwapHarness() {
  return (
    <>
      <Button
        testId="swap-modal-trigger"
        onClick={() => {
          setSwapOpen(true);
        }}
      >
        Pair
      </Button>
      <Modal
        open={swapOpen()}
        onOpenChange={next => {
          setSwapOpen(next);
        }}
        title="Pair a device"
        labelledBy="swap-modal-title"
        initialFocus={() => document.querySelector<HTMLElement>('[data-testid="swap-modal-answer"]') ?? undefined}
        refocusOn={step}
        testId="swap-modal"
      >
        <Modal.Head titleId="swap-modal-title" title={`Step ${String(step())}`} />
        <Modal.Actions>
          <Show when={step()} keyed>
            {current => (
              <Button variant="secondary" block testId="swap-modal-answer">
                {`Answer ${String(current)}`}
              </Button>
            )}
          </Show>
        </Modal.Actions>
      </Modal>
    </>
  );
}

/**
 * As a keyboard user, I see a dialog whose content swaps as it opens start on its answer, keep focus in it as its
 * content swaps while open, and get focus back on its trigger when it closes as its content swaps.
 */
export const RefocusesOnSwapWhileOpen: Story = {
  render: () => <SwapHarness />,
  beforeEach: () => {
    setSwapOpen(false);
    setStep(1);
  },
  play: async ({ step: storyStep }) => {
    const answer = (): HTMLElement => body.getByTestId('swap-modal-answer');
    const trigger = (): HTMLElement => body.getByTestId('swap-modal-trigger');
    await storyStep('Given focus on the trigger', async () => {
      trigger().focus();
      await expect(trigger()).toHaveFocus();
    });
    await storyStep('When it opens on content swapped as it opens', () => {
      setStep(2);
      setSwapOpen(true);
    });
    await storyStep('Then focus is on its answer', async () => {
      await waitFor(() => expect(answer()).toHaveFocus());
      await expect(answer()).toHaveTextContent('Answer 2');
    });
    await storyStep('When the content swaps while open', () => {
      setStep(3);
    });
    await storyStep('Then the answer is new and focus is on the card, not the page', async () => {
      await waitFor(() => expect(answer()).toHaveTextContent('Answer 3'));
      await waitFor(() => expect(body.getByTestId('swap-modal')).toHaveFocus());
    });
    await storyStep('When it closes as its content swaps', () => {
      setStep(4);
      setSwapOpen(false);
    });
    await storyStep('Then focus is back on the trigger, not on the card fading out', async () => {
      await waitFor(() => expect(trigger()).toHaveFocus());
      await expect(body.getByTestId('swap-modal-backdrop')).not.toHaveAttribute('data-open');
      await expect(trigger()).toHaveFocus();
    });
  },
};
