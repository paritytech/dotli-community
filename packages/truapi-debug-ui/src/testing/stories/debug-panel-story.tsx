// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What every debug panel story file spreads into its default export, since the panel draws its own page.

import { onCleanup } from 'solid-js';
import { createJSXDecorator, type Decorator, type Parameters } from 'storybook-solidjs-vite';
import palette from '../../palette.module.css';
import s from './debug-panel-story.module.css';

/** The panel's page under a story, in place of the page frame every other story gets. */
export const debugPanelStory: { parameters: Parameters; decorators: Decorator[] } = {
  parameters: {
    pageFrame: false,
    // Contrast is off because the panel's palette is kept as designed, and its contrast is the owner's call.
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } },
  },
  decorators: [
    // Once per mount, since the story memo will not render twice and a re-run on a globals change
    // empties the canvas.
    createJSXDecorator(Story => {
      // The page itself takes the palette, so a view shown on its own sits on the panel's colours as it does inside it.
      // The next story in the same preview gets its page back.
      const names = [palette['palette'], s['page']].filter(name => name !== undefined);
      document.body.classList.add(...names);
      onCleanup(() => {
        document.body.classList.remove(...names);
      });
      return (
        <div class={s['root']} data-testid="story-root">
          <Story />
        </div>
      );
    }),
  ],
};
