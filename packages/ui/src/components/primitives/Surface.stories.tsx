// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { Button } from './Button.js';
import { Chip } from './Chip.js';
import { Hint, ReloadIcon, Surface, SurfaceFoot, SurfaceHead } from './Surface.js';
import { Callout, InfoIcon, Well } from './Well.js';

const meta = {
  title: 'Primitives/Surface',
  component: Surface,
  args: { width: 'md', label: 'Settings', children: <></> },
  argTypes: { width: { control: 'inline-radio', options: ['sm', 'md', 'lg', 'xl'] } },
  render: args => (
    <Surface {...args}>
      <SurfaceHead title="Settings" aside={<Chip tone="outline">Paseo</Chip>} />
      <Well>
        <Callout icon={<InfoIcon />}>Surfaces hold a popover's content.</Callout>
      </Well>
      <SurfaceFoot hint={<Hint icon={<ReloadIcon />}>Transport and cache changes reload the app</Hint>}>
        <Button variant="primary" size="sm">
          Save and apply
        </Button>
      </SurfaceFoot>
    </Surface>
  ),
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Small: Story = { args: { width: 'sm' } };
export const Medium: Story = {};
export const Large: Story = { args: { width: 'lg' } };
export const ExtraLarge: Story = { args: { width: 'xl' } };
export const InSheet: Story = { args: { sheet: true }, globals: { viewport: { value: 'phone', isRotated: false } } };
