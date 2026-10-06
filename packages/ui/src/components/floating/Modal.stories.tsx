// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { Callout } from '../primitives/Well.js';
import { Modal } from './Modal.js';

const TRASH_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
  '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

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
      <Modal.Head titleId="story-modal-title" title="Clear site data" icon={TRASH_SVG} />
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

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('Then it is a sheet titled Clear site data', async () => {
      await waitFor(() => expect(body.getByTestId('story-modal-sheet-title')).toHaveTextContent('Clear site data'));
    });
  },
};

export const SwitchesFormKeepingContent: Story = {
  play: async ({ userEvent, step }) => {
    const input = () => body.getByTestId<HTMLInputElement>('story-password');
    await step('Given I typed a password in the card', async () => {
      await waitFor(() => expect(input()).toHaveFocus());
      await userEvent.type(input(), 'hunter2');
    });
    await step('When the window narrows to a phone', async () => {
      const { page } = await import('vitest/browser');
      await page.viewport(390, 844);
    });
    await step('Then the sheet shows the same field, value and focus', async () => {
      await waitFor(() => expect(body.getByTestId('story-modal-sheet-head')).toBeInTheDocument());
      await expect(input().value).toBe('hunter2');
      await expect(input()).toHaveFocus();
    });
  },
};
