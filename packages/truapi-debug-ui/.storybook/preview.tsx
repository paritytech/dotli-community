// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { merge } from 'solid-js';
import { createJSXDecorator, type Preview } from 'storybook-solidjs-vite';
import { themes } from 'storybook/theming';
import palette from '../src/palette.module.css';
import s from './preview.module.css';

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    // The decorator's wrapper pads every story, so docs blocks get the page too.
    layout: 'fullscreen',
    docs: { theme: themes.dark },
    // The addon's default, 'todo', only warns, so a violation would pass CI. Contrast is off because the panel's palette
    // is kept as designed, and its contrast is the owner's call.
    a11y: { test: 'error', config: { rules: [{ id: 'color-contrast', enabled: false }] } },
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '800px' }, type: 'desktop' },
      },
    },
  },
  // The default render passes the args store itself as props, so a prop read once in the body
  // is an untracked store read and trips STRICT_READ_UNTRACKED. A merge view checks `in` first.
  render: (args, context) => {
    const Component = context.component;
    if (Component === undefined) {
      throw new Error(`Story ${context.id} has no component and no render`);
    }
    const props = merge(args, {});
    return <Component {...props} />;
  },
  decorators: [
    // Once per mount, since the story memo will not render twice and a re-run on a globals change
    // empties the canvas.
    createJSXDecorator(Story => {
      // The page itself takes the palette, so a view shown on its own sits on the panel's colours as it does inside it.
      document.body.classList.add(...[palette['palette'], s['page']].filter(name => name !== undefined));
      return (
        <div class={s['root']} data-testid="story-root">
          <Story />
        </div>
      );
    }),
  ],
};

export default preview;
