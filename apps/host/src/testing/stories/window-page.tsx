// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createJSXDecorator, type Decorator, type Parameters } from 'storybook-solidjs-vite';
import s from './window-page.module.css';

/** The sign-in window's page under a story, a column as tall as the viewport, in place of the padded page frame. */
export const windowPageStory: { parameters: Parameters; decorators: Decorator[] } = {
  parameters: { pageFrame: false },
  decorators: [
    // Once per mount, since the story memo will not render twice and a re-run on a globals change
    // empties the canvas.
    createJSXDecorator(Story => (
      <div class={s['page']} data-testid="story-root">
        <Story />
      </div>
    )),
  ],
};
