// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { Popover } from './Popover.js';

const onOpenChange = fn().mockName('onOpenChange');
// The surface is portalled into the body, outside the story's canvas.
const body = within(document.body);

const Failing = lazy(() => Promise.reject(new Error('chunk')));

function Harness(props: { content?: 'buttons' | 'failing' }) {
  const content = (): JSX.Element =>
    props.content === 'failing' ? (
      <Failing />
    ) : (
      <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
        <Button testId="inside-a">A</Button>
        <Button testId="inside-b">B</Button>
      </div>
    );
  return (
    <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
      <Popover id="story-popover" title="Example" onOpenChange={onOpenChange}>
        <Popover.Trigger>
          {t => (
            <Button {...t} testId="trigger">
              Open
            </Button>
          )}
        </Popover.Trigger>
        <Popover.Content testId="story-popover-surface">{content()}</Popover.Content>
      </Popover>
    </div>
  );
}

const meta = {
  title: 'Floating/Popover',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    onOpenChange.mockClear();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Trusted input, a user's: the browser's invokers act on it only. Loaded on
 * use, so the stories still load in Storybook outside Vitest.
 */
const input = async () => (await import('vitest/browser')).userEvent;
const press = async (testId: string) => {
  await (await input()).click(body.getByTestId(testId));
};

export const Open: Story = {
  play: async ({ step }) => {
    await step('When I press the button', () => press('trigger'));
    await step('Then the anchored dialog is open, focus on its first control', async () => {
      const surface = body.getByTestId('story-popover-surface');
      await waitFor(() => expect(surface).toHaveAttribute('data-open'));
      await expect(surface).toHaveAttribute('role', 'dialog');
      await expect(surface).toHaveAccessibleName('Example');
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(body.getByTestId('inside-a')).toHaveFocus());
    });
  },
};

export const PhoneSheet: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('When I press the button on a phone', () => press('trigger'));
    await step('Then a bottom sheet titled Example opens, and no anchored layer', async () => {
      await waitFor(() => expect(body.getByTestId('popover-sheet-title')).toHaveTextContent('Example'));
      const sheet = document.getElementById('story-popover') as HTMLDialogElement;
      await expect(sheet.open).toBe(true);
      await expect(document.querySelectorAll(':popover-open')).toHaveLength(0);
      await expect(onOpenChange.mock.calls).toEqual([[true]]);
    });
  },
};

export const LazyContentFails: Story = {
  args: { content: 'failing' },
  play: async ({ step }) => {
    await step('When I open the popover whose content cannot load', () => press('trigger'));
    await step('Then it opened, and closed again', async () => {
      await waitFor(() => expect(onOpenChange.mock.calls).toEqual([[true], [false]]));
      await waitFor(() => expect(document.getElementById('story-popover')).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('trigger')).toHaveAttribute('aria-expanded', 'false');
    });
  },
};
