// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createJSXDecorator, type Preview } from 'storybook-solidjs-vite';
import palette from '../src/palette.module.css';
import s from './preview.module.css';

const preview: Preview = {
  parameters: {
    // Contrast is off because the panel's palette is kept as designed, and its contrast is the owner's call.
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } },
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
