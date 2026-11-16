// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { CloudOffIcon, ShieldAlertIcon } from '../../icons.js';
import type { ErrorPageContent, ErrorText } from './arrangeErrorActions.js';
import { Well } from '../../components/primitives/Well.js';
import { ErrorActions, ErrorDetail, ErrorFrame } from './ErrorFrame.js';
import s from './ErrorPage.module.css';

function Text(props: { text: ErrorText }): JSX.Element {
  return (
    <For each={typeof props.text === 'string' ? [props.text] : props.text}>
      {part => (typeof part === 'string' ? part : <strong>{part.strong}</strong>)}
    </For>
  );
}

/** The error page: what failed, what to try, and the actions, the recommended one last. */
export function ErrorPage(props: { page: ErrorPageContent; standalone: boolean }): JSX.Element {
  const tips = (): readonly string[] => props.page.tips ?? [];
  return (
    <ErrorFrame
      standalone={props.standalone}
      icon={props.page.glyph === 'warning' ? ShieldAlertIcon : CloudOffIcon}
      warning={props.page.glyph === 'warning'}
      title={props.page.title}
      focusTitle
    >
      <Show when={props.page.detail}>
        {detail => (
          <ErrorDetail>
            <Text text={detail()} />
          </ErrorDetail>
        )}
      </Show>
      <Show when={tips().length > 0}>
        <Well class={s['tips']} testId="error-page-tips">
          <p class={s['tipsLabel']}>Try</p>
          {/* One tip is a plain line in the well. Two or more are a list. */}
          <Show
            when={tips().length > 1}
            fallback={
              <p class={s['tip']} data-testid="error-page-tip">
                {tips()[0]}
              </p>
            }
          >
            <ul class={s['tipsList']} data-testid="error-page-tips-list">
              <For each={tips()}>{tip => <li>{tip}</li>}</For>
            </ul>
          </Show>
        </Well>
      </Show>
      <ErrorActions actions={props.page.actions ?? []} />
    </ErrorFrame>
  );
}
