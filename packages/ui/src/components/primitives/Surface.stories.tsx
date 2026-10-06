// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { InSheet as InSheetContext } from '../floating/in-sheet.js';
import layer from '../floating/FloatingLayer.module.css';
import popover from '../floating/Popover.module.css';
import frame from '../floating/SheetFrame.module.css';
import { Button } from './Button.js';
import { Chip } from './Chip.js';
import { Hint, ReloadIcon, Surface, SurfaceFoot, SurfaceHead } from './Surface.js';
import { Callout, InfoIcon, Well } from './Well.js';

/** A Popover's open surface, the glass around its content, as a bottom sheet with `sheet`. */
const Frame = (props: { sheet?: boolean; children: JSX.Element }) => (
  <Show
    when={props.sheet === true}
    fallback={
      <div class={[layer['layer'], layer['topbarEnd'], popover['surface']].join(' ')} data-open="">
        <InSheetContext value={() => false}>{props.children}</InSheetContext>
      </div>
    }
  >
    <div data-open="" style={{ position: 'fixed', right: 0, bottom: 0, left: 0 }}>
      <div class={frame['sheet']} data-sheet="">
        <div class={frame['body']}>
          <InSheetContext value={() => true}>{props.children}</InSheetContext>
        </div>
      </div>
    </div>
  </Show>
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
