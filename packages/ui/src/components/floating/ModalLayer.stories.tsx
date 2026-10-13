// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { Portal } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { ModalLayer } from './ModalLayer.js';

const onDismissFirst = fn().mockName('onDismissFirst');
// The layers are portalled into the body, outside the story's canvas.
const body = within(document.body);

/** A page with a button behind, a native popover beside it, and two layers, the second opened from the first. */
function Harness() {
  const [first, setFirst] = createSignal(false);
  const [second, setSecond] = createSignal(false);
  return (
    <>
      <div style={{ display: 'flex', gap: '8px' }}>
        <Button testId="behind" onClick={() => setFirst(true)}>
          Open first
        </Button>
      </div>
      <Portal>
        <div popover="auto" data-testid="native-popover" style={{ padding: '12px' }}>
          A native popover
        </div>
      </Portal>
      <ModalLayer
        open={first()}
        onDismiss={() => {
          onDismissFirst();
          setFirst(false);
        }}
        testId="first"
        label="First"
        layout="sheet"
      >
        <div data-modal-surface="" style={{ padding: '16px', display: 'flex', gap: '8px' }}>
          <Button testId="open-second" onClick={() => setSecond(true)}>
            Open second
          </Button>
          <Button testId="close-first" onClick={() => setFirst(false)}>
            Close
          </Button>
        </div>
      </ModalLayer>
      <ModalLayer open={second()} onDismiss={() => setSecond(false)} testId="second" label="Second" layout="center">
        <div data-modal-surface="" style={{ padding: '16px' }}>
          <Button testId="close-second" onClick={() => setSecond(false)}>
            Close second
          </Button>
        </div>
      </ModalLayer>
    </>
  );
}

const meta = {
  title: 'Floating/ModalLayer',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '420px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    onDismissFirst.mockClear();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

const openFirst = async (user: { click: (el: Element) => Promise<void> }) => {
  await user.click(body.getByTestId('behind'));
  await waitFor(() => expect(body.getByTestId('first-backdrop')).toHaveAttribute('data-open'));
};

export const PageBehindInertPopoversAside: Story = {
  play: async ({ canvasElement, userEvent, step }) => {
    const page = canvasElement.closest('body > *');
    const popover = body.getByTestId('native-popover');
    await step('Given a native popover is open beside the page', async () => {
      popover.showPopover();
      await expect(popover.matches(':popover-open')).toBe(true);
    });
    await step('When the first layer opens', () => openFirst(userEvent));
    await step(
      'Then it is a modal dialog, the page behind is inert, and the popover closed without going inert',
      async () => {
        const frame = body.getByTestId('first-backdrop');
        await expect(frame).toHaveAttribute('role', 'dialog');
        await expect(frame).toHaveAttribute('aria-modal', 'true');
        await expect(frame).not.toHaveAttribute('inert');
        await expect(page).toHaveAttribute('inert');
        await expect(popover).not.toHaveAttribute('inert');
        await expect(popover.matches(':popover-open')).toBe(false);
      },
    );
    await step('When it closes', async () => {
      await userEvent.click(body.getByTestId('close-first'));
    });
    await step('Then the page answers again', async () => {
      await waitFor(() => expect(page).not.toHaveAttribute('inert'));
    });
  },
};

export const SecondLayerAloneAnswers: Story = {
  play: async ({ canvasElement, userEvent, step }) => {
    const page = canvasElement.closest('body > *');
    await step('Given the first layer is open', () => openFirst(userEvent));
    await step('When a second layer opens over it', async () => {
      await userEvent.click(body.getByTestId('open-second'));
      await waitFor(() => expect(body.getByTestId('second-backdrop')).toHaveAttribute('data-open'));
    });
    await step('Then only the second answers, marked as following another', async () => {
      await expect(body.getByTestId('first-backdrop')).toHaveAttribute('inert');
      await expect(body.getByTestId('second-backdrop')).not.toHaveAttribute('inert');
      await expect(body.getByTestId('second-backdrop')).toHaveAttribute('data-follows');
    });
    await step('When the second closes', async () => {
      await userEvent.click(body.getByTestId('close-second'));
    });
    await step('Then the first answers again and the page stays inert', async () => {
      await waitFor(() => expect(body.getByTestId('first-backdrop')).not.toHaveAttribute('inert'));
      await expect(page).toHaveAttribute('inert');
    });
  },
};

export const EscapeWithFocusOnBody: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given the layer is open and I clicked off its controls', async () => {
      await openFirst(userEvent);
      (document.activeElement as HTMLElement | null)?.blur();
      await expect(document.activeElement).toBe(document.body);
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then the layer is dismissed once', async () => {
      await expect(onDismissFirst).toHaveBeenCalledOnce();
      await waitFor(() => expect(body.getByTestId('first-backdrop')).not.toHaveAttribute('data-open'));
    });
  },
};
