// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import type { LoadingState } from '../../state/loading.js';
import { LoadingScreen } from './LoadingScreen.js';

// As the page's build-time render paints it.
const START: LoadingState = {
  progress: 0,
  step: ['Reaching out'],
  explanation: '',
  explanationOpacity: 1,
  srText: '',
  warning: null,
  phase: 'active',
};

// Each write builds on a plain copy, since the signal lags a write until Solid's flush.
let current = START;
const [state, setState] = createSignal<LoadingState>(START);

/** Moves the load on, as the page's loading controller does. */
function update(patch: Partial<LoadingState>): void {
  current = { ...current, ...patch };
  setState(current);
}

const meta = {
  title: 'Host/LoadingScreen',
  component: LoadingScreen,
  parameters: { chrome: true },
  tags: ['!autodocs'],
  args: { state },
  beforeEach: () => {
    update(START);
  },
} satisfies Meta<typeof LoadingScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const before = {
  progress: 37.4,
  step: ['Downloading the app'],
  explanation: 'The files come from',
  explanationOpacity: 0.8,
  srText: 'The files come from many computers at once',
  warning: 'Still looking for peers',
};

/** As a visitor, progress, lines and warning made before the screen mounts show at once. */
export const StateBeforeHydration: Story = {
  beforeEach: () => {
    update(before);
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('Then the screen shows the load already underway', async () => {
      await expect(canvas.getByRole('progressbar', { name: 'Loading' })).toHaveAttribute('aria-valuenow', '37');
      await expect(canvas.getByText('37%')).toBeInTheDocument();
      await expect(canvasElement.querySelector('#loading-step')).toHaveTextContent('Downloading the app');
      await expect(canvasElement.querySelector('#status')).toHaveTextContent('The files come from');
      await expect(canvasElement.querySelector('#status-sr')).toHaveTextContent(
        'The files come from many computers at once',
      );
      await expect(canvas.getByRole('status')).toHaveAttribute('data-visible');
      await expect(canvas.getByRole('status')).toHaveTextContent('Still looking for peers');
    });
  },
};

/** As a visitor, the loading screen follows the load, with names and warnings shown as text. */
export const FollowsStore: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('When the load moves on', () => {
      update({
        progress: 62.6,
        step: ['Looking up ', { host: 'my<b>app</b>', tld: '.dot' }],
        explanation: 'Catching up',
        explanationOpacity: 0.9,
        srText: 'Catching up on the newest blocks',
        warning: 'Slow <b>peers</b>',
      });
    });
    await step('Then the screen follows, with markup shown as text', async () => {
      await waitFor(() => expect(canvas.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '63'));
      await expect(canvas.getByText('63%')).toBeInTheDocument();
      const line = canvasElement.querySelector('#loading-step');
      await expect(line).toHaveTextContent('Looking up my<b>app</b>.dot');
      await expect(line?.querySelector('b')).toBeNull();
      await expect(canvasElement.querySelector('#status')).toHaveTextContent('Catching up');
      await expect(canvasElement.querySelector('#status-sr')).toHaveTextContent('Catching up on the newest blocks');
      const warning = canvas.getByRole('status');
      await expect(warning).toHaveAttribute('data-visible');
      await expect(warning).toHaveTextContent('Slow <b>peers</b>');
      await expect(warning.querySelector('b')).toBeNull();
    });
    await step('When the warning clears', () => {
      update({ warning: null });
    });
    await step('Then the warning hides and is empty', async () => {
      const warning = canvas.getByRole('status', { hidden: true });
      await waitFor(() => expect(warning).not.toHaveAttribute('data-visible'));
      await expect(warning).toHaveTextContent('');
    });
  },
};
