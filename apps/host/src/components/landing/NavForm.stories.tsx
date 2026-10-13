// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { NavForm } from './NavForm.js';

const SUFFIX = '.dot';

/** The form as the page hydrates it: no TLD until the browser knows the visitor's network. */
function Hydrated(): JSX.Element {
  const [suffix, setSuffix] = createSignal<string | null>(null);
  onSettled(() => {
    setSuffix(SUFFIX);
  });
  return <NavForm suffix={suffix} />;
}

const meta = {
  title: 'Host/Landing/NavForm',
  component: Hydrated,
  // Its ids are the page's, so each story keeps its own frame.
  tags: ['!autodocs'],
} satisfies Meta<typeof Hydrated>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyForm: Story = {
  play: async ({ canvas, step }) => {
    const field = canvas.getByRole('textbox', { name: `Search a ${SUFFIX} name` });
    await step('Then I see a name field for the network, ready once the page knows it, and a Go button', async () => {
      await waitFor(() => expect(field).toBeEnabled());
      await expect(field).toHaveAttribute('aria-describedby', 'dotli-nav-error');
      await expect(field).toHaveAttribute('spellcheck', 'false');
      await expect(field).toHaveAttribute('autocomplete', 'off');
      await expect(canvas.getByRole('button', { name: 'Go' })).toHaveAttribute('type', 'submit');
    });
    await step('And no error', async () => {
      await expect(canvas.queryByRole('alert')).toBeNull();
    });
  },
};

export const NothingFocusedOnLoad: Story = {
  play: async ({ canvas, step }) => {
    await step('Then nothing has focus, so a screen reader starts at the top and no keyboard pops up', async () => {
      await waitFor(() => expect(canvas.getByRole('textbox')).toBeEnabled());
      await expect(document.activeElement).toBe(document.body);
    });
  },
};

export const InvalidNameInline: Story = {
  play: async ({ canvas, userEvent, step }) => {
    const field = canvas.getByRole('textbox');
    const href = window.location.href;
    await step('When I submit a name that is not valid', async () => {
      await waitFor(() => expect(field).toBeEnabled());
      await userEvent.type(field, 'Bad Name{Enter}');
    });
    await step('Then I see why inline, the field is marked and keeps focus, and I stay on the page', async () => {
      await expect(canvas.getByRole('alert')).toHaveTextContent('Names can only contain a-z, 0-9 and hyphens');
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(canvas.getByTestId('story-root').querySelector('[data-invalid]')).not.toBeNull();
      await expect(field).toHaveFocus();
      await expect(window.location.href).toBe(href);
    });
    await step('When I type again', async () => {
      await userEvent.clear(field);
      await userEvent.type(field, 'bad');
    });
    await step('Then the error clears', async () => {
      await expect(canvas.queryByRole('alert')).toBeNull();
      await expect(field).not.toHaveAttribute('aria-invalid');
      await expect(canvas.getByTestId('story-root').querySelector('[data-invalid]')).toBeNull();
    });
  },
};

export const EmptySubmitAsksForName: Story = {
  play: async ({ canvas, userEvent, step }) => {
    await step('When I press Go with nothing typed', async () => {
      await waitFor(() => expect(canvas.getByRole('button', { name: 'Go' })).toBeEnabled());
      await userEvent.click(canvas.getByRole('button', { name: 'Go' }));
    });
    await step('Then I am asked for a name', async () => {
      await expect(canvas.getByRole('alert')).toHaveTextContent('Enter a name to browse');
    });
  },
};

export const FirstPlaceholder: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the first placeholder is the first example name, the TLD shown beside it, not in it', async () => {
      const field = canvas.getByRole('textbox');
      await waitFor(() => expect(field).toBeEnabled());
      await expect(field).toHaveAttribute('placeholder', 'browse');
      await expect(canvas.getByText(SUFFIX)).toBeVisible();
    });
  },
};
