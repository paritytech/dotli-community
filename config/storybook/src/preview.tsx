// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The preview every Storybook shares. A package's own preview adds its stylesheet and anything only it needs.

import { merge } from 'solid-js';
import type { Preview } from 'storybook-solidjs-vite';
import { themes } from 'storybook/theming';

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    // The page frame pads every story, so docs blocks get the page too.
    layout: 'fullscreen',
    docs: { theme: themes.dark },
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
};

export default preview;
