// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { createNavComboboxState, type NavKey } from '../../state/navComboboxState.js';
import { NAME_ERROR_COPY, NavForm } from './NavForm.js';

const SUFFIX = '.dot';

type HydratedProps = {
  /** The suggestions' answer to a key the input offers them. */
  onKey: (key: NavKey) => boolean;
};

/** The form as the page hydrates it: no TLD until the browser knows the visitor's network, and no suggestions shown. */
function Hydrated(props: HydratedProps): JSX.Element {
  const [suffix, setSuffix] = createSignal<string | null>(null);
  const combobox = createNavComboboxState();
  onSettled(() => {
    setSuffix(SUFFIX);
  });
  onSettled(() => combobox.handleKeys(props.onKey));
  return <NavForm suffix={suffix} listbox={() => null} combobox={combobox} />;
}

const meta = {
  title: 'Host/Landing/NavForm',
  component: Hydrated,
  args: { onKey: fn(() => false) },
  // Its ids are the page's, so each story keeps its own frame.
  tags: ['!autodocs'],
} satisfies Meta<typeof Hydrated>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, I load the page with nothing focused, so a screen reader starts at the top. */
export const NothingFocusedOnLoad: Story = {
  play: async ({ canvas, step }) => {
    await step('Then nothing has focus, so a screen reader starts at the top and no keyboard pops up', async () => {
      await waitFor(() => expect(canvas.getByRole('combobox')).toBeEnabled());
      await expect(document.activeElement).toBe(document.body);
    });
  },
};

/** As a visitor, I am told inline why a name is not valid, and the error clears when I type again. */
export const InvalidNameInline: Story = {
  play: async ({ canvas, userEvent, step }) => {
    const field = canvas.getByRole('combobox');
    const href = window.location.href;
    await step('When I submit a name that is not valid', async () => {
      await waitFor(() => expect(field).toBeEnabled());
      await userEvent.type(field, 'Bad Name{Enter}');
    });
    await step('Then I see why inline, the field is marked and keeps focus, and I stay on the page', async () => {
      await expect(canvas.getByRole('alert')).toHaveTextContent('Names can only contain a-z, 0-9 and hyphens');
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveAccessibleDescription('Names can only contain a-z, 0-9 and hyphens');
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
      await expect(field).not.toHaveAttribute('aria-describedby');
      await expect(field).toHaveAccessibleDescription('');
      await expect(canvas.getByTestId('story-root').querySelector('[data-invalid]')).toBeNull();
    });
  },
};

/** As a visitor pressing Enter on an empty name while the suggestions leave the key to the form, I see the form's own error. */
export const EnterLeftToTheForm: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    const field = canvas.getByRole('combobox');
    await step('When I focus the name input', async () => {
      await waitFor(() => expect(field).toBeEnabled());
      await userEvent.click(field);
    });
    await step('Then it is a combobox whose suggestions are collapsed', async () => {
      await expect(field).toHaveAttribute('aria-expanded', 'false');
    });
    await step('When I press Enter on the empty name', async () => {
      await userEvent.keyboard('{Enter}');
    });
    await step("Then the suggestions were offered the key, and I see the form's own error", async () => {
      await expect(args.onKey).toHaveBeenCalledWith('Enter');
      await expect(canvas.getByRole('alert')).toHaveTextContent(NAME_ERROR_COPY.empty);
    });
  },
};

/** As a visitor pressing Enter on a name while the suggestions take the key, the form does not submit it as well. */
export const EnterTakenBySuggestions: Story = {
  args: { onKey: fn(() => true) },
  play: async ({ args, canvas, userEvent, step }) => {
    const field = canvas.getByRole('combobox');
    await step('When I press Enter on a name the form would reject', async () => {
      await waitFor(() => expect(field).toBeEnabled());
      await userEvent.type(field, 'Bad Name{Enter}');
    });
    await step('Then the suggestions took the key, and the form did not submit, so it shows no error', async () => {
      await expect(args.onKey).toHaveBeenCalledWith('Enter');
      await expect(canvas.queryByRole('alert')).toBeNull();
    });
  },
};

/** As a visitor composing text with an IME, my keys go to the IME and the suggestions never see them. */
export const KeysDuringCompositionLeftToTheIme: Story = {
  args: { onKey: fn(() => true) },
  play: async ({ args, canvas, step }) => {
    const field = canvas.getByRole('combobox');
    await step('When I press Enter while composing', async () => {
      await waitFor(() => expect(field).toBeEnabled());
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    });
    await step('Then the suggestions were not offered the key', async () => {
      await expect(args.onKey).not.toHaveBeenCalled();
    });
  },
};
