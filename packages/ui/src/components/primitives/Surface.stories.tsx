// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Popover } from '../floating/Popover.js';
import { Button } from './Button.js';
import { Chip } from './Chip.js';
import { InfoIcon } from '../icons/InfoIcon.js';
import { ReloadIcon } from '../icons/ReloadIcon.js';
import { Hint, Surface, SurfaceFoot, SurfaceHead } from './Surface.js';
import { Callout, Well } from './Well.js';

/** The surface in a real popover, held open: anchored on a wide screen, a bottom sheet on a phone. */
function Frame(props: { children: JSX.Element }): JSX.Element {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <Button ref={setTrigger}>Settings</Button>
      <Popover id="story-surface" title="Settings" trigger={trigger()} open={trigger() !== undefined}>
        {props.children}
      </Popover>
    </>
  );
}

// The popover renders into the page's floating layer, outside the story's body.
const body = within(document.body);

type SurfaceArgs = Parameters<typeof Surface>[0];
const settings = (args: SurfaceArgs) => (
  <Surface {...args} padded>
    <SurfaceHead title="Settings" aside={<Chip tone="mono">Paseo</Chip>} />
    <Well>
      <Callout icon={InfoIcon}>Surfaces hold a popover's content.</Callout>
    </Well>
    <SurfaceFoot hint={<Hint icon={ReloadIcon}>Transport and cache changes reload the app</Hint>}>
      <Button variant="primary" size="sm">
        Save and apply
      </Button>
    </SurfaceFoot>
  </Surface>
);

const meta = {
  title: 'Primitives/Surface',
  component: Surface,
  // Own docs iframes, since the frame is fixed to the top right of its page.
  parameters: { chrome: true, docs: { story: { inline: false, height: '320px' } } },
  args: { width: 'md', children: <></> },
  argTypes: { width: { control: 'inline-radio', options: ['sm', 'md', 'lg', 'xl'] } },
  render: args => <Frame>{settings(args)}</Frame>,
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see the small popover surface. */
export const Small: Story = { args: { width: 'sm' } };
/** As a dotli user, I read a popover surface with its title, body and footer. */
export const Medium: Story = {
  args: { testId: 'surface' },
  play: async ({ step }) => {
    await step('Then I read the popover with its title, its body and its footer', async () => {
      await waitFor(() => expect(body.getByTestId('surface').tagName).toBe('SECTION'));
      await expect(body.getByRole('heading', { level: 2, name: 'Settings' })).toBeInTheDocument();
      await expect(body.getByText("Surfaces hold a popover's content.")).toBeInTheDocument();
      await expect(body.getByText('Transport and cache changes reload the app')).toBeInTheDocument();
      await expect(body.getByRole('button', { name: 'Save and apply' })).toBeInTheDocument();
    });
  },
};
/** As a dotli user, I see the large popover surface. */
export const Large: Story = { args: { width: 'lg' } };
/** As a dotli user, I see the extra large popover surface. */
export const ExtraLarge: Story = { args: { width: 'xl' } };
/** As a phone user, I hear the title once, since the surface in a sheet leaves it to the sheet. */
export const InSheet: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('Then the surface leaves the title to the sheet, so I hear it once', async () => {
      await waitFor(() => expect(body.getAllByRole('heading', { name: 'Settings' })).toHaveLength(1));
      await expect(body.getByTestId('popover-sheet-title')).toHaveTextContent('Settings');
      await expect(body.getByRole('button', { name: 'Save and apply' })).toBeInTheDocument();
    });
  },
};
