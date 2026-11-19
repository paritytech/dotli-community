// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
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
  onClose: () => void;
};

/** The list renders in the top layer, outside the story's canvas. */
const body = within(document.body);

/** The list below a name input as wide as the page's. */
function Frame(props: FrameProps): JSX.Element {
  const [input, setInput] = createSignal<HTMLElement | undefined>(undefined, { ownedWrite: true });
  return (
    <div style={{ width: '480px' }}>
      <input ref={setInput} type="text" aria-label="Name" data-testid="story-name-input" style={{ width: '100%' }} />
      <Suggestions
        anchor={input}
        recent={() => props.recent}
        apps={() => props.apps}
        loading={() => props.loading}
        suffix={() => '.dot'}
        active={() => props.active}
        onPick={props.onPick}
        onForget={props.onForget}
        onClose={props.onClose}
      />
    </div>
  );
}

const meta = {
  title: 'Host/Landing/Suggestions',
  component: Frame,
  args: { recent: RECENT, apps: APPS, loading: false, active: 'apple', onPick: fn(), onForget: fn(), onClose: fn() },
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
  play: async ({ step }) => {
    await step('Then four names show and only apple is selected', async () => {
      await expect(await body.findAllByRole('option')).toHaveLength(4);
      const selected = body.getAllByRole('option', { selected: true });
      await expect(selected).toEqual([body.getByRole('option', { name: 'apple.dot' })]);
    });
  },
};

/** As a returning visitor, I focus the empty name input and see only my recent names. */
export const RecentOnFocus: Story = {
  args: { recent: ['news', 'browse'], apps: [], active: null },
  play: async ({ step }) => {
    await step('Then my recent names show in their own section, and no app section', async () => {
      const recent = await body.findByRole('group', { name: 'Recent' });
      await expect(within(recent).getAllByRole('option')).toHaveLength(2);
      await expect(body.getAllByRole('group')).toEqual([recent]);
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
      const option = await body.findByRole('option', { name: 'avocado.dot' });
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
  play: async ({ args, step }) => {
    await step('When I click the cross on axe', async () => {
      const option = await body.findByRole('option', { name: 'axe.dot' });
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
  play: async ({ step }) => {
    await step('Then the list shows a status and no names', async () => {
      await expect(await body.findByRole('status')).toBeInTheDocument();
      await expect(body.queryAllByRole('option')).toEqual([]);
    });
  },
};
