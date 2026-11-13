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
type Args = Parameters<typeof SegmentedControl<Theme>>[0];

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

// The glyphs are made per render, since one node would move between controls.
/** As a dotli user, I press an icon option and it becomes the pressed one and is reported. */
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

/** As a dotli user, I see a large control stack each icon over its label and pick Dark, which is reported. */
export const Large: Story = {
  args: { size: 'lg', block: true },
  render: args => {
    const [value, setValue] = createSignal<Theme>(untrack(() => args.value));
    const options: readonly SegmentOption<Theme>[] = [
      { value: 'light', label: 'Light', icon: <SunIcon />, testId: 'seg-light' },
      { value: 'dark', label: 'Dark', icon: <MoonIcon />, testId: 'seg-dark' },
      { value: 'system', label: 'System', icon: <MonitorIcon />, testId: 'seg-system' },
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
};

/** As a screen reader user, I hear a named group with the current option pressed. */
export const NamedGroup: Story = {
  args: { value: 'light' },
  play: async ({ canvas, mount, step }) => {
    await step('When the control renders on Light', async () => {
      await mount();
    });
    await step('Then I hear a named group with the current option pressed', async () => {
      const group = canvas.getByRole('group', { name: 'Theme' });
      await expect(group).toBeVisible();
      await expect(canvas.getByTestId('seg-system')).toHaveAttribute('aria-pressed', 'false');
      await expect(canvas.getByTestId('seg-light')).toHaveAttribute('aria-pressed', 'true');
      await expect(canvas.getByTestId('seg-dark')).toHaveAttribute('aria-pressed', 'false');
    });
  },
};

/** As a dotli user, I press the option that is already picked and nothing is reported. */
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

/** As a keyboard user, I find one Tab stop in the control and it follows the value I pick. */
export const OneTabStopFollowsValue: Story = {
  args: { value: 'light' },
  render: renderOwned,
  play: async ({ canvas, userEvent, mount, step }) => {
    await step('When the control renders on Light', async () => {
      await mount();
    });
    await step('Then the pressed option is the one Tab stop', async () => {
      await expect(readTabStops(canvas)).toEqual(['-1', '0', '-1']);
    });
    await step('When I pick Dark', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dark' }));
    });
    await step('Then the Tab stop follows the value', async () => {
      await expect(readTabStops(canvas)).toEqual(['-1', '-1', '0']);
    });
  },
};

/** As a keyboard user, I find the first option is the Tab stop when none is pressed. */
export const FirstIsTabStopWhenNonePressed: Story = {
  render: args => <SegmentedControl<Theme | 'unset'> {...args} value="unset" />,
  play: async ({ canvas, mount, step }) => {
    await step('When the control renders with no option pressed', async () => {
      await mount();
    });
    await step('Then the first option is the Tab stop', async () => {
      await expect(readTabStops(canvas)).toEqual(['0', '-1', '-1']);
    });
  },
};

/** As a keyboard user, I move focus between options with the arrows, Home and End, wrapping, and pick nothing. */
export const ArrowsMoveWithoutPicking: Story = {
  args: { value: 'light' },
  render: renderOwned,
  play: async ({ args, canvas, userEvent, step }) => {
    const focusedAfterKeys: (string | null | undefined)[] = [];
    await step('When I focus the pressed option', () => {
      canvas.getByTestId('seg-light').focus();
    });
    await step('Then it has focus', async () => {
      await expect(canvas.getByTestId('seg-light')).toHaveFocus();
    });
    await step('When I press the arrows, Home and End', async () => {
      for (const key of [
        '{ArrowRight}',
        '{ArrowRight}',
        '{ArrowLeft}',
        '{ArrowDown}',
        '{ArrowUp}',
        '{Home}',
        '{End}',
      ]) {
        await userEvent.keyboard(key);
        focusedAfterKeys.push(document.activeElement?.getAttribute('data-testid'));
      }
    });
    await step('Then focus moved, wrapping, to each option in turn', async () => {
      await expect(focusedAfterKeys).toEqual([
        'seg-dark',
        'seg-system',
        'seg-dark',
        'seg-system',
        'seg-dark',
        'seg-system',
        'seg-dark',
      ]);
    });
    await step('And nothing is picked', async () => {
      await expect(args.onChange).not.toHaveBeenCalled();
      await expect(canvas.getByTestId('seg-light')).toHaveAttribute('aria-pressed', 'true');
    });
  },
};

/** As a keyboard user, I find the option I arrowed to is the Tab stop while focus is inside, and Tab leaves the control at once. */
export const ArrowedOptionIsTabStop: Story = {
  args: { value: 'light' },
  render: renderWithNext,
  play: async ({ canvas, userEvent, step }) => {
    await step('When I arrow from the pressed option to the first', async () => {
      canvas.getByTestId('seg-light').focus();
      await userEvent.keyboard('{ArrowLeft}');
    });
    await step('Then the arrowed option has focus and is the Tab stop while focus is inside', async () => {
      await expect(canvas.getByTestId('seg-system')).toHaveFocus();
      await expect(readTabStops(canvas)).toEqual(['0', '-1', '-1']);
    });
    await step('When I press Tab', async () => {
      await userEvent.tab();
    });
    await step('Then focus leaves the control at once', async () => {
      await expect(canvas.getByTestId('after')).toHaveFocus();
    });
    await step('And the pressed option is the Tab stop again', async () => {
      await expect(readTabStops(canvas)).toEqual(['-1', '0', '-1']);
    });
  },
};

/** As a keyboard user, I type other keys and they reach the page untouched and pick nothing. */
export const OtherKeysPassThrough: Story = {
  args: { value: 'light' },
  render: renderWithNext,
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I focus the pressed option and type a letter', async () => {
      canvas.getByTestId('seg-light').focus();
      await userEvent.keyboard('a');
    });
    await step('Then the pressed option keeps focus', async () => {
      await expect(canvas.getByTestId('seg-light')).toHaveFocus();
    });
    await step('When I press Tab', async () => {
      await userEvent.tab();
    });
    await step('Then the keys reach the page untouched and nothing is picked', async () => {
      await expect(canvas.getByTestId('after')).toHaveFocus();
      await expect(args.onChange).not.toHaveBeenCalled();
    });
  },
};

/** As a dotli user, I press an option of a disabled control, nothing is picked, and my focus stays on it. */
export const Disabled: Story = {
  args: { disabled: true },
  render: renderOwned,
  play: async ({ args, canvas, userEvent, mount, step }) => {
    await step('When a disabled control renders', async () => {
      await mount();
    });
    await step('Then the control shows disabled', async () => {
      await expect(canvas.getByRole('group')).toHaveAttribute('aria-disabled', 'true');
      await expect(canvas.getByTestId('seg-dark')).toHaveAttribute('aria-disabled', 'true');
    });
    await step('When I press Dark with the pointer and with the keyboard', async () => {
      await userEvent.click(canvas.getByTestId('seg-dark'));
      canvas.getByTestId('seg-dark').focus();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then nothing was picked and Dark keeps focus', async () => {
      await expect(args.onChange).not.toHaveBeenCalled();
      await expect(canvas.getByTestId('seg-system')).toHaveAttribute('aria-pressed', 'true');
      await expect(canvas.getByTestId('seg-dark')).toHaveFocus();
    });
  },
};

// The owner takes each pick.
function renderOwned(args: Args) {
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
}

// A button after the control, for Tab to land on.
function renderWithNext(args: Args) {
  return (
    <div style={{ display: 'flex', gap: '12px' }}>
      <SegmentedControl<Theme> {...args} />
      <button type="button" data-testid="after">
        After
      </button>
    </div>
  );
}

function readTabStops(canvas: { getByTestId: (id: string) => HTMLElement }): (string | null)[] {
  return OPTIONS.map(option => canvas.getByTestId(option.testId).getAttribute('tabindex'));
}
