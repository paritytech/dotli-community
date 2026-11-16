// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { RotateCwIcon, SlidersIcon } from '../../icons.js';
import { showError } from './showError.js';
import { showErrorPage } from './showErrorPage.js';

// The page mounts its own root, so each play shows one in the story's `#app`.

const XSS = '<img src=x onerror="alert(1)">';

const meta = {
  title: 'Pages/ErrorPage',
  render: () => <div id="app" />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, I see what failed under its mark and each action with its icon. */
export const TitleActionsAndIcons: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('As a visitor, I see what failed under its mark, and each action with its icon', async () => {
      // When
      showErrorPage({
        title: 'Could not load the app',
        detail: 'The network did not answer.',
        actions: [
          { label: 'Reload', icon: RotateCwIcon, onClick: () => undefined },
          { label: 'Open Settings', icon: SlidersIcon, onClick: () => undefined },
        ],
      });

      // Then
      await expect(canvas.getByTestId('error-page-title')).toHaveTextContent('Could not load the app');
      await expect(canvas.getByTestId('error-page-icon').tagName).toBe('svg');
      await expect(canvas.getByRole('button', { name: 'Reload' })).toBeVisible();
      await expect(canvas.getByRole('button', { name: 'Open Settings' })).toBeVisible();
      await expect(canvas.getAllByTestId('error-page-action-icon')).toHaveLength(2);
    });
  },
};

/** As a visitor, I see markup in a message, title, tip or button label shown as plain text. */
export const MarkupShownAsText: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a visitor, markup in a message, its plain and bold parts, the title, a tip and a button label is shown to me as text',
      async () => {
        // When
        showErrorPage({
          title: XSS,
          detail: [XSS, ' tail ', { strong: XSS }],
          tips: [XSS],
          actions: [{ label: XSS, onClick: () => undefined }],
        });

        // Then
        await expect(canvasElement.querySelector('img')).toBeNull();
        await expect(canvas.getByTestId('error-page-title')).toHaveTextContent(XSS, { normalizeWhitespace: false });
        await expect(canvas.getByTestId('error-page-detail').textContent).toBe(`${XSS} tail ${XSS}`);
        await expect(
          within(canvas.getByTestId('error-page-detail')).getByText(XSS, { selector: 'strong' }),
        ).toBeVisible();
        await expect(canvas.getByTestId('error-page-tip').textContent).toBe(XSS);
        await expect(canvas.getByTestId('error-page-retry-label').textContent).toBe(XSS);
      },
    );
  },
};

/** As a visitor, I see no empty Try list or button row when there is nothing to suggest or click. */
export const NoEmptyTipsOrActions: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a visitor, I see no empty Try list or button row when there is nothing to suggest or click',
      async () => {
        // When
        showErrorPage({ title: 'Could not load the app', tips: [], actions: [] });

        // Then
        await expect(canvas.getByTestId('error-page')).toBeVisible();
        await expect(canvas.queryByTestId('error-page-tips')).toBeNull();
        await expect(canvas.queryByTestId('error-page-actions')).toBeNull();
      },
    );
  },
};

/** As a screen reader user, I hear the new screen announced when it replaces the old one and its title takes no tab stop. */
export const TitleTakesFocusWithoutTabStop: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a screen-reader user, the new screen is announced when it replaces the old one, and the title takes no tab stop',
      async () => {
        // When
        showErrorPage({ title: "Your connection won't be verified", glyph: 'warning' });

        // Then
        const title = canvas.getByTestId('error-page-title');
        await expect(title).toHaveFocus();
        await expect(title).toHaveAttribute('tabindex', '-1');
      },
    );
  },
};

/** As a keyboard user, I reach the buttons in the order I read them, with the recommended one last. */
export const KeyboardOrderMatchesReading: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a keyboard user, I reach the buttons in the order I read them, the recommended one last',
      async () => {
        // When
        showErrorPage({
          title: 'Could not load the app',
          actions: [
            { label: 'Reload', primary: true, onClick: () => undefined },
            { label: 'Open Settings', onClick: () => undefined },
          ],
        });

        // Then
        const buttons = canvas.getAllByRole('button');
        await expect(buttons.map(b => b.textContent)).toEqual(['Open Settings', 'Reload']);
        await expect(buttons[1]).toHaveAttribute('data-variant', 'primary');
        await expect(buttons[1]).toHaveAttribute('id', 'error-retry-btn');
      },
    );
  },
};

/** As a visitor, I see tips handed to the shorthand as a list and a bare retry callback shown as a Retry button with the reload arrow. */
export const ShimTipsAndRetryButton: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a visitor, tips passed to the shorthand reach the page, and a bare retry callback becomes a Retry button',
      async () => {
        // Given a retry callback that records its call
        let clicked = false;

        // When the shorthand shows a page and I press its Retry button
        showError('Could not reach the network', {
          detail: 'The light client lost its peers.',
          action: () => {
            clicked = true;
          },
          tips: ['Checking your internet connection.', 'Closing other dot.li tabs, then reloading.'],
        });
        canvas.getByRole('button', { name: 'Retry' }).click();

        // Then
        await expect(
          within(canvas.getByTestId('error-page-tips-list'))
            .getAllByRole('listitem')
            .map(item => item.textContent),
        ).toEqual(['Checking your internet connection.', 'Closing other dot.li tabs, then reloading.']);
        await expect(clicked).toBe(true);
        await expect(
          within(canvas.getByRole('button', { name: 'Retry' })).getByTestId('error-page-action-icon'),
        ).toBeVisible();
      },
    );
  },
};

/** As a visitor, I read a single tip as a plain line under its Try label, not as a one-item list. */
export const OneTipAsLine: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('As a visitor, I read a single tip as a plain line, not as a one-item list', async () => {
      // When
      showErrorPage({
        title: 'Could not reach the network',
        detail: 'The light client lost its peers.',
        tips: ['Checking your internet connection.'],
        actions: [{ label: 'Retry', icon: RotateCwIcon, primary: true, onClick: () => undefined }],
      });

      // Then
      await expect(canvas.getByTestId('error-page-tip')).toHaveTextContent('Checking your internet connection.');
      await expect(canvas.queryByTestId('error-page-tips-list')).toBeNull();
    });
  },
};
