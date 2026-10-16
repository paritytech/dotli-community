// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { Accordion, type AccordionProps } from './Accordion.js';

const meta = {
  title: 'Primitives/Accordion',
  parameters: { chrome: true },
  component: Accordion,
  args: {
    title: 'Advanced',
    testId: 'accordion',
    summaryTestId: 'accordion-summary',
    children: <p data-testid="accordion-body">Every permission, one by one.</p>,
  },
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

type Canvas = Parameters<NonNullable<Story['play']>>[0]['canvas'];

const root = (canvas: Canvas): HTMLDetailsElement => {
  const found = canvas.getByTestId('accordion');
  if (!(found instanceof HTMLDetailsElement)) {
    throw new Error('The accordion is not a details element');
  }
  return found;
};

const summary = (canvas: Canvas): HTMLElement => canvas.getByTestId('accordion-summary');

/** As a dotli user, I open and close a section by pointer and it reports each change. */
export const Pointer: Story = {
  args: { onToggle: fn() },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given the section is closed', async () => {
      await expect(root(canvas).open).toBe(false);
      await expect(summary(canvas)).toHaveTextContent('Advanced');
      await expect(canvas.getByTestId('accordion-body')).not.toBeVisible();
    });
    await step('When I click its header', async () => {
      await userEvent.click(summary(canvas));
    });
    await step('Then it opens, shows its body and reports it', async () => {
      await waitFor(() => expect(root(canvas).open).toBe(true));
      await expect(canvas.getByTestId('accordion-body')).toBeVisible();
      await waitFor(() => expect(args.onToggle).toHaveBeenCalledTimes(1));
      await expect(args.onToggle).toHaveBeenCalledWith(true);
    });
    await step('When I click its header again', async () => {
      await userEvent.click(summary(canvas));
    });
    await step('Then it closes and reports it', async () => {
      await waitFor(() => expect(root(canvas).open).toBe(false));
      await waitFor(() => expect(args.onToggle).toHaveBeenCalledTimes(2));
      await expect(args.onToggle).toHaveBeenLastCalledWith(false);
    });
  },
};

// The browser opens a section only on trusted keys.
/** As a keyboard user, I reach the header with Tab and open and close the section with Enter and Space. */
export const Keyboard: Story = {
  play: async ({ canvas, step }) => {
    const userEvent = await trustedInput();
    await step('When I tab to the header', async () => {
      await userEvent.tab();
    });
    await step('Then the header has focus and the section is closed', async () => {
      await expect(summary(canvas)).toHaveFocus();
      await expect(root(canvas).open).toBe(false);
    });
    await step('When I press Enter', async () => {
      await userEvent.keyboard('{Enter}');
    });
    await step('Then it opens', async () => {
      await waitFor(() => expect(root(canvas).open).toBe(true));
    });
    await step('When I press Space', async () => {
      await userEvent.keyboard(' ');
    });
    await step('Then it closes', async () => {
      await waitFor(() => expect(root(canvas).open).toBe(false));
    });
  },
};

/** As a keyboard user, I open a section and Tab reaches what is in it while it is still unfolding. */
export const TabIntoBody: Story = {
  args: {
    children: (
      <button type="button" data-testid="accordion-action">
        Allow
      </button>
    ),
  },
  play: async ({ canvas, step }) => {
    const userEvent = await trustedInput();
    await step('When I open the section from the keyboard and press Tab at once', async () => {
      summary(canvas).focus();
      await userEvent.keyboard('{Enter}');
      await userEvent.tab();
    });
    await step('Then focus is on the action in its body', async () => {
      await expect(root(canvas).open).toBe(true);
      await expect(canvas.getByTestId('accordion-action')).toHaveFocus();
    });
  },
};

// The owner holds the state and does not take the change, as an owner that refuses it would.
/** As a dotli user, I click a controlled section's header and its owner hears the next state while it stays closed. */
export const OwnerDecides: Story = {
  args: { open: false, onToggle: fn() },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I click its header', async () => {
      await userEvent.click(summary(canvas));
    });
    await step('Then its owner hears it should open and the section stays closed', async () => {
      await expect(args.onToggle).toHaveBeenCalledTimes(1);
      await expect(args.onToggle).toHaveBeenCalledWith(true);
      await expect(root(canvas).open).toBe(false);
    });
    await step('When I press Enter on its header', async () => {
      await (await trustedInput()).keyboard('{Enter}');
    });
    await step('Then its owner hears it again and the section stays closed', async () => {
      await expect(args.onToggle).toHaveBeenCalledTimes(2);
      await expect(args.onToggle).toHaveBeenLastCalledWith(true);
      await expect(root(canvas).open).toBe(false);
    });
  },
};

// The owner takes each change and can close the section itself, as the permissions panel does on every opening.
const Owned = (args: AccordionProps) => {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button
        type="button"
        data-testid="owner-close"
        onClick={() => {
          setOpen(false);
        }}
      >
        Close
      </button>
      <Accordion
        {...args}
        open={open()}
        onToggle={next => {
          setOpen(next);
          args.onToggle?.(next);
        }}
      />
    </>
  );
};

/** As a dotli user, I open a controlled section, it reports it, and it follows its owner closing it. */
export const Controlled: Story = {
  args: { onToggle: fn() },
  render: Owned,
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I click its header', async () => {
      await userEvent.click(summary(canvas));
    });
    await step('Then its owner hears it and the section opens', async () => {
      await expect(args.onToggle).toHaveBeenCalledTimes(1);
      await expect(args.onToggle).toHaveBeenCalledWith(true);
      await waitFor(() => expect(root(canvas).open).toBe(true));
    });
    let toggled: Promise<unknown> = Promise.resolve();
    await step('When its owner closes it', async () => {
      toggled = new Promise(resolve => {
        root(canvas).addEventListener('toggle', resolve, { once: true });
      });
      await userEvent.click(canvas.getByTestId('owner-close'));
    });
    await step('Then it closes and reports nothing more', async () => {
      await toggled;
      await expect(root(canvas).open).toBe(false);
      await expect(args.onToggle).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a dotli user, I see an open section. */
export const Open: Story = {
  render: args => <Accordion {...args} open onToggle={() => undefined} />,
};
