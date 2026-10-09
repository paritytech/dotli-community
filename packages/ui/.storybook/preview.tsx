// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { merge } from 'solid-js';
import { createJSXDecorator, type Preview } from 'storybook-solidjs-vite';
import { themes } from 'storybook/theming';
import '../src/global.css';
import s from './preview.module.css';

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    // The decorator's wrapper pads every story, so docs blocks get the page too.
    layout: 'fullscreen',
    docs: { theme: themes.dark },
    // The building blocks first, then what the app's domain composes from them.
    options: { storySort: { order: ['Primitives', 'Entities', '*'] } },
    // The addon's default, 'todo', only warns, so a violation would pass CI.
    a11y: { test: 'error' },
    viewport: {
      options: {
        // Phone sits below the 560 px PHONE_QUERY breakpoint, so the phone layouts apply.
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
    // empties the canvas. `parameters.chrome` marks stories the app renders under data-chrome.
    createJSXDecorator((Story, context) => {
      document.body.style.background = 'var(--bg-page)';
      return (
        <div
          class={s['root']}
          data-chrome={context.parameters['chrome'] === true ? '' : undefined}
          data-testid="story-root"
        >
          <Story />
        </div>
      );
    }),
  ],
};

export default preview;
