// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { showNoContentError } from '../../no-content-page.js';

// The page mounts its own root, so each play shows it in the story's `#app` as the host page does.

const XSS = '<img src=x onerror="alert(1)">';

const meta = {
  title: 'Host/Pages/NoContentPage',
  render: () => <div id="app" />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, I see markup in the domain of a no-content error shown as plain text. */
export const MarkupShownAsText: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('As a visitor, markup in the domain of a no-content error is shown to me as text', async () => {
      // Given
      showNoContentError(XSS);

      // Then
      await expect(canvasElement.querySelector('img')).toBeNull();
      await expect(canvas.getByTestId('error-page-domain').textContent.startsWith(XSS)).toBe(true);
    });
  },
};

/** As a visitor, I see that the app cannot be reached under a globe, with the name to check. */
export const TitleLineAndIcon: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('As a visitor, I see that the app cannot be reached under a globe, with the name to check', async () => {
      // When
      showNoContentError('nothing');

      // Then
      await expect(canvas.getByTestId('error-page-title')).toHaveTextContent("This app can't be reached");
      await expect(canvas.getByTestId('error-page-icon').tagName).toBe('svg');
      await expect(canvas.getByTestId('error-page-domain')).toHaveTextContent(/^nothing/);
      await expect(canvas.queryByRole('button')).toBeNull();
    });
  },
};

/** As a visitor, I read the page naming the app it could not reach, with no tab stop on its title. */
export const TitleTakesNoFocus: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('As a visitor, the page names the app it could not reach, with no tab stop on its title', async () => {
      // When
      showNoContentError('nothing');

      // Then
      await expect(canvas.getByTestId('error-page-title')).toHaveTextContent("This app can't be reached");
      await expect(canvas.getByTestId('error-page-title')).not.toHaveAttribute('tabindex');
      await expect(canvas.getByTestId('error-page-title')).not.toHaveFocus();
      await expect(canvas.getByTestId('error-page-detail')).toHaveTextContent(/^Check if there is a typo in nothing/);
    });
  },
};
