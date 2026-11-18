// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { Suggestions } from './Suggestions.js';

const RECENT = ['axe'];
const APPS = ['ant', 'apple', 'avocado'];

type FrameProps = {
  recent: readonly string[];
  apps: readonly string[];
  loading: boolean;
  active: string | null;
  onPick: (label: string) => void;
  onForget: (label: string) => void;
};

/** The list below a name input, inside a positioned frame as the page places it. */
function Frame(props: FrameProps): JSX.Element {
  return (
    <div style={{ position: 'relative', width: '480px' }}>
      <input type="text" aria-label="Name" data-testid="story-name-input" />
      <Suggestions
        recent={() => props.recent}
        apps={() => props.apps}
        loading={() => props.loading}
        suffix={() => '.dot'}
        active={() => props.active}
        onPick={props.onPick}
        onForget={props.onForget}
      />
    </div>
  );
}

const meta = {
  title: 'Host/Landing/Suggestions',
  component: Frame,
  args: { recent: RECENT, apps: APPS, loading: false, active: 'apple', onPick: fn(), onForget: fn() },
  // Its ids are the page's, so each story keeps its own frame.
  tags: ['!autodocs'],
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * As a returning visitor typing a name, I see the recent name that matches, then the app names, and the one the arrow
 * keys point at is selected.
 */
export const ActiveSelected: Story = {
  play: async ({ canvas, step }) => {
    await step('Then four names show and only apple is selected', async () => {
      await expect(await canvas.findAllByRole('option')).toHaveLength(4);
      const selected = canvas.getAllByRole('option', { selected: true });
      await expect(selected).toEqual([canvas.getByRole('option', { name: 'apple.dot' })]);
    });
  },
};

/** As a returning visitor, I focus the empty name input and see only my recent names. */
export const RecentOnFocus: Story = {
  args: { recent: ['news', 'browse'], apps: [], active: null },
  play: async ({ canvas, step }) => {
    await step('Then my recent names show in their own section, and no app section', async () => {
      const recent = await canvas.findByRole('group', { name: 'Recent' });
      await expect(within(recent).getAllByRole('option')).toHaveLength(2);
      await expect(canvas.getAllByRole('group')).toEqual([recent]);
    });
  },
};

/** As a visitor typing a name, I click a suggested name and it is picked while the input keeps focus. */
export const ClickPicks: Story = {
  args: { active: null },
  play: async ({ args, canvas, step }) => {
    const input = canvas.getByTestId('story-name-input');
    await step('Given the name input has focus', () => {
      input.focus();
    });
    await step('When I click avocado', async () => {
      const option = await canvas.findByRole('option', { name: 'avocado.dot' });
      await (await trustedInput()).click(option);
    });
    await step('Then avocado is picked and the input still has focus', async () => {
      await expect(args.onPick).toHaveBeenCalledWith('avocado');
      await expect(input).toHaveFocus();
    });
  },
};

/** As a returning visitor, I click the cross on a recent name and it is forgotten. */
export const CrossForgets: Story = {
  args: { active: null },
  play: async ({ args, canvas, step }) => {
    await step('When I click the cross on axe', async () => {
      const option = await canvas.findByRole('option', { name: 'axe.dot' });
      await (await trustedInput()).click(within(option).getByTestId('listbox-remove'));
    });
    await step('Then axe is forgotten', async () => {
      await expect(args.onForget).toHaveBeenCalledWith('axe');
    });
  },
};

/** As a visitor typing a name while the names still load, I see the list open with only a loading row. */
export const NoMatchesWhileLoading: Story = {
  args: { recent: [], apps: [], loading: true, active: null },
  play: async ({ canvas, step }) => {
    await step('Then the list shows a status and no names', async () => {
      await expect(await canvas.findByRole('status')).toBeInTheDocument();
      await expect(canvas.queryAllByRole('option')).toEqual([]);
    });
  },
};
