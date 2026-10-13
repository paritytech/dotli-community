// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { MonitorIcon } from '../icons/MonitorIcon.js';
import { MoonIcon } from '../icons/MoonIcon.js';
import { SunIcon } from '../icons/SunIcon.js';
import { SegmentedControl, type SegmentOption } from './SegmentedControl.js';

type Theme = 'system' | 'light' | 'dark';
const OPTIONS = [
  { value: 'system', label: 'System', testId: 'seg-system' },
  { value: 'light', label: 'Light', testId: 'seg-light' },
  { value: 'dark', label: 'Dark', testId: 'seg-dark' },
] as const satisfies readonly { value: Theme; label: string; testId: string }[];

const meta = {
  title: 'Primitives/SegmentedControl',
  parameters: { chrome: true },
  component: SegmentedControl<Theme>,
  args: { label: 'Theme', options: OPTIONS, value: 'system', onChange: fn() },
} satisfies Meta<typeof SegmentedControl<Theme>>;

export default meta;
type Story = StoryObj<typeof meta>;

type Args = Parameters<typeof SegmentedControl<Theme>>[0];

// The owner takes each pick, as the Appearance picker does.
const Owned = (args: Args) => {
  const [value, setValue] = createSignal<Theme>(untrack(() => args.value));
  return (
    <SegmentedControl<Theme>
      {...args}
      value={value()}
      onChange={next => {
        setValue(next);
        args.onChange(next);
      }}
    />
  );
};

const tabStops = (canvas: { getByTestId: (id: string) => HTMLElement }): (string | null)[] =>
  OPTIONS.map(option => canvas.getByTestId(option.testId).getAttribute('tabindex'));

export const Labels: Story = {
  render: Owned,
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given System is pressed and I focus it', async () => {
      await expect(canvas.getByTestId('seg-system')).toHaveAttribute('aria-pressed', 'true');
      canvas.getByTestId('seg-system').focus();
    });
    await step('When I press ArrowRight, then End, then Enter', async () => {
      await userEvent.keyboard('{ArrowRight}');
      await expect(canvas.getByTestId('seg-light')).toHaveFocus();
      await userEvent.keyboard('{End}{Enter}');
    });
    await step('Then Dark is pressed and reported', async () => {
      await expect(canvas.getByTestId('seg-dark')).toHaveAttribute('aria-pressed', 'true');
      await expect(args.onChange).toHaveBeenCalledWith('dark');
    });
  },
};

// The glyphs are made per render, since one node would move between controls.
export const Icons: Story = {
  render: args => {
    const [value, setValue] = createSignal<Theme>(untrack(() => args.value));
    const options: readonly SegmentOption<Theme>[] = [
      { value: 'light', label: 'Light', icon: <SunIcon size={14} />, testId: 'seg-light' },
      { value: 'dark', label: 'Dark', icon: <MoonIcon size={14} />, testId: 'seg-dark' },
      { value: 'system', label: 'System', icon: <MonitorIcon size={14} />, testId: 'seg-system' },
    ];
    return (
      <SegmentedControl<Theme>
        {...args}
        options={options}
        value={value()}
        onChange={next => {
          setValue(next);
          args.onChange(next);
        }}
      />
    );
  },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press Light', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Light' }));
    });
    await step('Then Light is pressed and reported', async () => {
      await expect(canvas.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
      await expect(args.onChange).toHaveBeenCalledWith('light');
    });
  },
};

export const NamedGroup: Story = {
  args: { value: 'light' },
  play: async ({ canvas, step }) => {
    await step('Then I hear a named group with the current option pressed', async () => {
      const group = canvas.getByRole('group', { name: 'Theme' });
      await expect(group).toBeVisible();
      await expect(canvas.getByTestId('seg-system')).toHaveAttribute('aria-pressed', 'false');
      await expect(canvas.getByTestId('seg-light')).toHaveAttribute('aria-pressed', 'true');
      await expect(canvas.getByTestId('seg-dark')).toHaveAttribute('aria-pressed', 'false');
    });
  },
};

export const PressingPickedChangesNothing: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press the option that is already picked', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'System' }));
    });
    await step('Then nothing is reported', async () => {
      await expect(args.onChange).not.toHaveBeenCalled();
    });
  },
};

export const OneTabStopFollowsValue: Story = {
  args: { value: 'light' },
  render: Owned,
  play: async ({ canvas, userEvent, step }) => {
    await step('Given the pressed option is the one Tab stop', async () => {
      await expect(tabStops(canvas)).toEqual(['-1', '0', '-1']);
    });
    await step('When I pick Dark', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dark' }));
    });
    await step('Then the Tab stop follows the value', async () => {
      await expect(tabStops(canvas)).toEqual(['-1', '-1', '0']);
    });
  },
};

export const FirstIsTabStopWhenNonePressed: Story = {
  render: args => <SegmentedControl<Theme | 'unset'> {...args} value="unset" />,
  play: async ({ canvas, step }) => {
    await step('Then the first option is the Tab stop', async () => {
      await expect(tabStops(canvas)).toEqual(['0', '-1', '-1']);
    });
  },
};

export const ArrowsMoveWithoutPicking: Story = {
  args: { value: 'light' },
  render: Owned,
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given I focus the pressed option', async () => {
      canvas.getByTestId('seg-light').focus();
      await expect(canvas.getByTestId('seg-light')).toHaveFocus();
    });
    await step('When I press the arrows, Home and End, then focus moves, wrapping, to each option', async () => {
      const moves: [string, string][] = [
        ['{ArrowRight}', 'seg-dark'],
        ['{ArrowRight}', 'seg-system'],
        ['{ArrowLeft}', 'seg-dark'],
        ['{ArrowDown}', 'seg-system'],
        ['{ArrowUp}', 'seg-dark'],
        ['{Home}', 'seg-system'],
        ['{End}', 'seg-dark'],
      ];
      for (const [key, focused] of moves) {
        await userEvent.keyboard(key);
        await expect(canvas.getByTestId(focused)).toHaveFocus();
      }
    });
    await step('Then nothing is picked', async () => {
      await expect(args.onChange).not.toHaveBeenCalled();
      await expect(canvas.getByTestId('seg-light')).toHaveAttribute('aria-pressed', 'true');
    });
  },
};

// A button after the control, for Tab to land on.
const WithNext = (args: Args) => (
  <div style={{ display: 'flex', gap: '12px' }}>
    <SegmentedControl<Theme> {...args} />
    <button type="button" data-testid="after">
      After
    </button>
  </div>
);

export const ArrowedOptionIsTabStop: Story = {
  args: { value: 'light' },
  render: WithNext,
  play: async ({ canvas, userEvent, step }) => {
    await step('Given I arrow from the pressed option to the first', async () => {
      canvas.getByTestId('seg-light').focus();
      await userEvent.keyboard('{ArrowLeft}');
      await expect(canvas.getByTestId('seg-system')).toHaveFocus();
    });
    await step('Then the arrowed option is the Tab stop while focus is inside', async () => {
      await expect(tabStops(canvas)).toEqual(['0', '-1', '-1']);
    });
    await step('When I press Tab, then it leaves the control at once', async () => {
      await userEvent.tab();
      await expect(canvas.getByTestId('after')).toHaveFocus();
    });
    await step('Then the pressed option is the Tab stop again', async () => {
      await expect(tabStops(canvas)).toEqual(['-1', '0', '-1']);
    });
  },
};

export const OtherKeysPassThrough: Story = {
  args: { value: 'light' },
  render: WithNext,
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given the pressed option has focus', async () => {
      canvas.getByTestId('seg-light').focus();
      await expect(canvas.getByTestId('seg-light')).toHaveFocus();
    });
    await step('When I type a letter and then press Tab', async () => {
      await userEvent.keyboard('a');
      await expect(canvas.getByTestId('seg-light')).toHaveFocus();
      await userEvent.tab();
    });
    await step('Then the keys reach the page untouched and nothing is picked', async () => {
      await expect(canvas.getByTestId('after')).toHaveFocus();
      await expect(args.onChange).not.toHaveBeenCalled();
    });
  },
};
