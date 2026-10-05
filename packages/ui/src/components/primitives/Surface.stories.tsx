// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import type { JSX } from '@solidjs/web';
import { InSheet as InSheetContext } from '../sheet/in-sheet.js';
import frame from '../sheet/Sheet.module.css';
import popover from '../shell/Popover.module.css';
import { Button } from './Button.js';
import { Chip } from './Chip.js';
import { Hint, ReloadIcon, Surface, SurfaceFoot, SurfaceHead } from './Surface.js';
import { Callout, InfoIcon, Well } from './Well.js';

/** A Popover's open surface, the glass around its content, as a bottom sheet with `sheet`. */
const Frame = (props: { sheet?: boolean; children: JSX.Element }) => (
  <div
    class={[frame['anchored'], popover['surface'], frame['sheet']]}
    data-open=""
    data-sheet={props.sheet === true ? '' : undefined}
  >
    <div class={props.sheet === true ? frame['body'] : undefined}>
      <InSheetContext value={() => props.sheet === true}>{props.children}</InSheetContext>
    </div>
  </div>
);

type SurfaceArgs = Parameters<typeof Surface>[0];
const settings = (args: SurfaceArgs) => (
  <Surface {...args}>
    <SurfaceHead title="Settings" aside={<Chip tone="mono">Paseo</Chip>} />
    <Well>
      <Callout icon={<InfoIcon />}>Surfaces hold a popover's content.</Callout>
    </Well>
    <SurfaceFoot hint={<Hint icon={<ReloadIcon />}>Transport and cache changes reload the app</Hint>}>
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

export const Small: Story = { args: { width: 'sm' } };
export const Medium: Story = {};
export const Large: Story = { args: { width: 'lg' } };
export const ExtraLarge: Story = { args: { width: 'xl' } };
export const InSheet: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: args => <Frame sheet>{settings(args)}</Frame>,
};
