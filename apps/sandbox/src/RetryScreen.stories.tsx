// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { showError } from '@dotli/ui';
import { showRetryScreen } from './showRetryScreen.js';

// The screens mount their own root, so each play shows one in the story's `#app` as the sandbox page does.

const meta = {
  title: 'Sandbox/RetryScreen',
  render: () => <div id="app" />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor whose load failed, I retry and the error page gives way to the retry screen. */
export const RetryScreenReplacesErrorPage: Story = {
  tags: ['!autodocs'],
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('As a visitor whose load failed, retrying swaps the error page for the retry screen', async () => {
      // Given
      showError('Failed to load content', { detail: 'd', action: () => undefined });

      // When
      showRetryScreen();

      // Then
      await expect(canvas.queryByTestId('error-page')).toBeNull();
      await expect(canvas.getByTestId('retry-screen')).toBeVisible();
      await expect(canvas.getByTestId('retry-screen')).toHaveTextContent('Retrying…');
    });
  },
};
