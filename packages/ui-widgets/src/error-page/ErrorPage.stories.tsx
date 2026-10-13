// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { ReloadIcon, SlidersIcon } from '@dotli/ui/icons';
import { showError, showErrorPage } from './show-error-page.js';

// The page mounts its own root, so each play shows one in the story's `#app` as the host page does.

const XSS = '<img src=x onerror="alert(1)">';

const meta = {
  title: 'Pages/ErrorPage',
  render: () => <div id="app" />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

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
          { label: 'Reload', icon: ReloadIcon, onClick: () => undefined },
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

export const MarkupShownAsText: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a visitor, markup in a message, its plain and bold parts, the title, a tip and a button label is shown to me as text',
      async () => {
        // Given
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
        await expect(within(canvas.getByTestId('error-page-tips-list')).getByRole('listitem').textContent).toBe(XSS);
        await expect(canvas.getByTestId('error-page-retry-label').textContent).toBe(XSS);
      },
    );
  },
};

export const NoEmptyTipsOrActions: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a visitor, I see no empty Try list or button row when there is nothing to suggest or click',
      async () => {
        // Given
        showErrorPage({ title: 't', tips: [], actions: [] });

        // Then
        await expect(canvas.getByTestId('error-page')).toBeVisible();
        await expect(canvas.queryByTestId('error-page-tips')).toBeNull();
        await expect(canvas.queryByTestId('error-page-actions')).toBeNull();
      },
    );
  },
};

export const ButtonGetsClickEvent: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a visitor, clicking a button that opens a panel hands it the click, so it can leave the panel open',
      async () => {
        // Given
        let got: MouseEvent | null = null;
        showErrorPage({
          title: 't',
          actions: [
            {
              label: 'A',
              onClick: event => {
                got = event;
              },
            },
          ],
        });

        // When
        canvas.getByRole('button', { name: 'A' }).click();

        // Then
        await expect(got).toBeInstanceOf(MouseEvent);
      },
    );
  },
};

export const WarningGlyphOnlyWhenWarning: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('As a visitor, I see the warning mark only on a screen that warns me', async () => {
      // When
      showErrorPage({ title: 't', glyph: 'warning' });

      // Then
      await expect(canvas.getByTestId('error-page-glyph')).toHaveAttribute('data-warning');

      // When
      showErrorPage({ title: 't' });

      // Then
      await expect(canvas.getByTestId('error-page-glyph')).not.toHaveAttribute('data-warning');
    });
  },
};

export const TitleTakesFocusWithoutTabStop: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a screen-reader user, the new screen is announced when it replaces the old one, and the title takes no tab stop',
      async () => {
        // When
        showErrorPage({ title: "Your connection won't be verified" });

        // Then
        const title = canvas.getByTestId('error-page-title');
        await expect(title).toHaveFocus();
        await expect(title).toHaveAttribute('tabindex', '-1');
      },
    );
  },
};

export const KeyboardOrderMatchesReading: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a keyboard user, I reach the buttons in the order I read them, the recommended one last',
      async () => {
        // When
        showErrorPage({
          title: 't',
          actions: [
            { label: 'Reload', primary: true, onClick: () => undefined },
            { label: 'Open Settings', onClick: () => undefined },
          ],
        });

        // Then
        const buttons = canvas.getAllByRole('button');
        await expect(buttons.map(b => b.textContent)).toEqual(['Open Settings', 'Reload']);
        await expect(buttons[1]).toHaveAttribute('data-primary');
        await expect(buttons[1]).toHaveAttribute('id', 'error-retry-btn');
      },
    );
  },
};

export const ShimTipsAndRetryButton: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step(
      'As a visitor, tips passed to the shorthand reach the page, and a bare retry callback becomes a Retry button',
      async () => {
        // Given
        let clicked = false;
        showError(
          't',
          'd',
          () => {
            clicked = true;
          },
          ['Check the cable.'],
        );

        // When
        canvas.getByRole('button', { name: 'Retry' }).click();

        // Then
        await expect(within(canvas.getByTestId('error-page-tips-list')).getByRole('listitem')).toHaveTextContent(
          'Check the cable.',
        );
        await expect(clicked).toBe(true);
      },
    );
  },
};
