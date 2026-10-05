// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { merge } from 'solid-js';
import type { Preview } from 'storybook-solidjs-vite';
import '../src/global.css';

const preview: Preview = {
  tags: ['autodocs'],
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'dark' },
  parameters: {
    layout: 'padded',
    // Every story is an a11y test in the stories lane.
    a11y: { test: 'error' },
    viewport: {
      options: {
        // Phone sits below the 560 px PHONE_QUERY breakpoint, so the phone layouts apply.
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '800px' }, type: 'desktop' },
      },
    },
  },
  // The framework's default render passes its args store itself as props, so
  // a prop no story sets but the component reads once in its body (Button's
  // ref) is an untracked store read and trips STRICT_READ_UNTRACKED. A merge
  // view checks `in` before it reads, as a call-site spread does in the app.
  render: (args, context) => {
    const Component = context.component;
    if (Component === undefined) {
      throw new Error(`Story ${context.id} has no component and no render`);
    }
    const props = merge(args, {});
    return <Component {...props} />;
  },
  decorators: [
    (Story, context) => {
      // As theme-controller.ts does: dark is the default, light is opted into on <html>.
      if (context.globals['theme'] === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      document.body.style.background = 'var(--bg-page)';
      return (
        <div data-chrome="" data-testid="story-root">
          <Story />
        </div>
      );
    },
  ],
};

export default preview;
