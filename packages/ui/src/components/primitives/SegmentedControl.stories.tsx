// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { createJSXDecorator, type Meta, type StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, within } from 'storybook/test';
import { MonitorIcon } from '../icons/MonitorIcon.js';
import { MoonIcon } from '../icons/MoonIcon.js';
import { SunIcon } from '../icons/SunIcon.js';
import { SegmentedControl, type SegmentedControlProps, type SegmentOption } from './SegmentedControl.js';

type Theme = 'system' | 'light' | 'dark';

const OPTIONS: readonly SegmentOption<Theme>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const PHONE = { viewport: { value: 'phone', isRotated: false } };

const meta = {
  title: 'Primitives/SegmentedControl',
  parameters: { chrome: true },
  component: SegmentedControl<Theme>,
  args: { label: 'Theme', options: OPTIONS, value: 'system', onChange: fn() },
  render: args => <OwnedSegmentedControl {...args} />,
} satisfies Meta<typeof SegmentedControl<Theme>>;

export default meta;
type Story = StoryObj<typeof meta>;

// A button after the control, for Tab to land on.
const withButtonAfter = createJSXDecorator(Story => (
  <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
    <Story />
    <button type="button">After</button>
  </div>
));

/** As a dotli user, I see the options in a sunken track with the current one pressed. */
export const Default: Story = {};

/** As a dotli user, I see each option's icon beside its label. */
export const Icons: Story = {
  render: args => <OwnedSegmentedControl {...args} options={createIconOptions()} />,
};

/** As a dotli user, I see a large control stack each icon over its label in a tile as wide as its share. */
export const Large: Story = {
  ...Icons,
  args: { size: 'lg', block: true },
};

/** As a phone user, I see taller options with more room around each label. */
export const Phone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
};

/** As a phone user, I see the large control's tiles grow taller and rounder. */
export const LargePhone: Story = {
  ...Large,
  tags: ['!autodocs'],
  globals: PHONE,
};

/** As a dotli user, I press another option and it becomes the one pressed and is reported. */
export const PressingPicks: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press Dark', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dark' }));
    });
    await step('Then Dark is the one pressed option and is reported', async () => {
      await expect(canvas.getAllByRole('button', { pressed: true })).toEqual([
        canvas.getByRole('button', { name: 'Dark' }),
      ]);
      await expect(args.onChange).toHaveBeenCalledWith('dark');
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
  play: async ({ canvas, userEvent, mount, step }) => {
    await step('When the control renders on Light', async () => {
      await mount();
    });
    await step('Then the pressed option is the one Tab stop', async () => {
      await expect(getTabStops(canvas.getByRole('group'))).toEqual([canvas.getByRole('button', { name: 'Light' })]);
    });
    await step('When I pick Dark', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dark' }));
    });
    await step('Then the Tab stop follows the value', async () => {
      await expect(getTabStops(canvas.getByRole('group'))).toEqual([canvas.getByRole('button', { name: 'Dark' })]);
    });
  },
};

/** As a keyboard user, I find the first option is the Tab stop when none is pressed. */
export const FirstIsTabStopWhenNonePressed: Story = {
  args: { options: OPTIONS.filter(option => option.value !== meta.args.value) },
  play: async ({ canvas, mount, step }) => {
    await step('When the control renders with no option pressed', async () => {
      await mount();
    });
    await step('Then the first option is the Tab stop', async () => {
      const [first] = canvas.getAllByRole('button');
      await expect(getTabStops(canvas.getByRole('group'))).toEqual([first]);
    });
  },
};

/** As a keyboard user, I move focus between options with the arrows, Home and End, wrapping, and pick nothing. */
export const ArrowsMoveWithoutPicking: Story = {
  args: { value: 'light' },
  play: async ({ args, canvas, userEvent, step }) => {
    const system = canvas.getByRole('button', { name: 'System' });
    const light = canvas.getByRole('button', { name: 'Light' });
    const dark = canvas.getByRole('button', { name: 'Dark' });
    const focusedAfterKeys: (Element | null)[] = [];
    await step('When I focus the pressed option', () => {
      light.focus();
    });
    await step('Then it has focus', async () => {
      await expect(light).toHaveFocus();
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
        focusedAfterKeys.push(document.activeElement);
      }
    });
    await step('Then focus moved, wrapping, to each option in turn', async () => {
      await expect(focusedAfterKeys).toEqual([dark, system, dark, system, dark, system, dark]);
    });
    await step('And nothing is picked', async () => {
      await expect(args.onChange).not.toHaveBeenCalled();
    });
  },
};

/** As a keyboard user, I find the option I arrowed to is the Tab stop while focus is inside, and Tab leaves the control at once. */
export const ArrowedOptionIsTabStop: Story = {
  args: { value: 'light' },
  decorators: [withButtonAfter],
  play: async ({ canvas, userEvent, step }) => {
    await step('When I arrow from the pressed option to the first', async () => {
      canvas.getByRole('button', { name: 'Light' }).focus();
      await userEvent.keyboard('{ArrowLeft}');
    });
    await step('Then the arrowed option has focus and is the Tab stop while focus is inside', async () => {
      const system = canvas.getByRole('button', { name: 'System' });
      await expect(system).toHaveFocus();
      await expect(getTabStops(canvas.getByRole('group'))).toEqual([system]);
    });
    await step('When I press Tab', async () => {
      await userEvent.tab();
    });
    await step('Then focus leaves the control at once', async () => {
      await expect(canvas.getByRole('button', { name: 'After' })).toHaveFocus();
    });
    await step('And the pressed option is the Tab stop again', async () => {
      await expect(getTabStops(canvas.getByRole('group'))).toEqual([canvas.getByRole('button', { name: 'Light' })]);
    });
  },
};

/** As a keyboard user, I type other keys and they reach the page untouched and pick nothing. */
export const OtherKeysPassThrough: Story = {
  args: { value: 'light' },
  decorators: [withButtonAfter],
  play: async ({ args, canvas, userEvent, step }) => {
    const light = canvas.getByRole('button', { name: 'Light' });
    await step('When I focus the pressed option and type a letter', async () => {
      light.focus();
      await userEvent.keyboard('a');
    });
    await step('Then the pressed option keeps focus', async () => {
      await expect(light).toHaveFocus();
    });
    await step('When I press Tab', async () => {
      await userEvent.tab();
    });
    await step('Then the keys reach the page untouched and nothing is picked', async () => {
      await expect(canvas.getByRole('button', { name: 'After' })).toHaveFocus();
      await expect(args.onChange).not.toHaveBeenCalled();
    });
  },
};

/**
 * As a dotli user, I find a disabled control announced as disabled, and when I press an option nothing is picked and my
 * focus stays on it.
 */
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ args, canvas, userEvent, mount, step }) => {
    await step('When a disabled control renders', async () => {
      await mount();
    });
    const dark = canvas.getByRole('button', { name: 'Dark' });
    // The options stay focusable, so the state reaches assistive technology only through `aria-disabled`.
    await step('Then the control and its options are announced as disabled', async () => {
      await expect(canvas.getByRole('group')).toHaveAttribute('aria-disabled', 'true');
      await expect(dark).toHaveAttribute('aria-disabled', 'true');
    });
    await step('When I press Dark with the pointer and with the keyboard', async () => {
      await userEvent.click(dark);
      dark.focus();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then nothing was picked and Dark keeps focus', async () => {
      await expect(args.onChange).not.toHaveBeenCalled();
      await expect(dark).toHaveFocus();
    });
  },
};

// A pick shows only once the owner takes it as the value, so the story owns the value and passes each pick on.
function OwnedSegmentedControl(props: SegmentedControlProps<Theme>) {
  const [value, setValue] = createSignal<Theme>(() => props.value);
  return (
    <SegmentedControl<Theme>
      {...props}
      value={value()}
      onChange={next => {
        setValue(next);
        props.onChange(next);
      }}
    />
  );
}

// The glyphs are made per render, since one node would move between controls.
function createIconOptions(): readonly SegmentOption<Theme>[] {
  return [
    { value: 'light', label: 'Light', icon: <SunIcon size={14} /> },
    { value: 'dark', label: 'Dark', icon: <MoonIcon size={14} /> },
    { value: 'system', label: 'System', icon: <MonitorIcon size={14} /> },
  ];
}

// The options Tab can land on.
function getTabStops(group: HTMLElement): HTMLElement[] {
  return within(group)
    .getAllByRole('button')
    .filter(option => option.tabIndex === 0);
}
