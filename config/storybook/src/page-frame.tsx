// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sets every story on the dotli page, as the apps render it.

import { onCleanup } from 'solid-js';
import { createJSXDecorator, type Preview } from 'storybook-solidjs-vite';
import s from './page-frame.module.css';

const preview: Preview = {
  decorators: [
    // Once per mount, since the story memo will not render twice and a re-run on a globals change
    // empties the canvas. `parameters.chrome` marks stories the app renders under data-chrome.
    createJSXDecorator((Story, context) => {
      // A story that draws its own page, such as the debug panel's, opts out.
      if (context.parameters['pageFrame'] === false) {
        return <Story />;
      }
      document.body.style.background = 'var(--bg-page)';
      // The next story in the same preview may draw its own page.
      onCleanup(() => document.body.style.removeProperty('background'));
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
