// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show, type Component } from 'solid-js';
import { dynamic, type JSX } from '@solidjs/web';
import { CloudOffIcon, ShieldAlertIcon, type IconProps } from '@dotli/ui/icons';
import { arrangeErrorActions, type ArrangedAction, type ErrorPageContent, type ErrorText } from './error-page.js';
import { ErrorDetail, ErrorFrame } from './ErrorFrame.js';
import s from './ErrorPage.module.css';

function Text(props: { text: ErrorText }): JSX.Element {
  return (
    <For each={typeof props.text === 'string' ? [props.text] : props.text}>
      {part => (typeof part === 'string' ? part : <strong>{part.strong}</strong>)}
    </For>
  );
}

function ActionIcon(props: { icon: Component<IconProps> }): JSX.Element {
  const Icon = dynamic(() => props.icon);
  return (
    <span class={s['retryIcon']} aria-hidden="true">
      <Icon testId="error-page-action-icon" />
    </span>
  );
}

function ActionButton(props: { arranged: ArrangedAction }): JSX.Element {
  return (
    <button
      id={props.arranged.id}
      class={s['retry']}
      data-primary={props.arranged.primary ? '' : undefined}
      onClick={event => {
        props.arranged.action.onClick(event);
      }}
    >
      <Show when={props.arranged.action.icon}>{icon => <ActionIcon icon={icon()} />}</Show>
      <span data-testid="error-page-retry-label">{props.arranged.action.label}</span>
    </button>
  );
}

/** The error page: what failed, what to try, and the actions, the recommended one last. */
export function ErrorPage(props: { page: ErrorPageContent; standalone: boolean }): JSX.Element {
  const tips = (): readonly string[] => props.page.tips ?? [];
  const actions = (): ArrangedAction[] => arrangeErrorActions(props.page.actions ?? []);
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
        <div class={s['tips']} data-testid="error-page-tips">
          <p class={s['tipsLabel']}>Try</p>
          <ul class={s['tipsList']} data-testid="error-page-tips-list">
            <For each={tips()}>{tip => <li>{tip}</li>}</For>
          </ul>
        </div>
      </Show>
      <Show when={actions().length > 0}>
        <div class={s['actions']} data-testid="error-page-actions">
          <For each={actions()}>{arranged => <ActionButton arranged={arranged} />}</For>
        </div>
      </Show>
    </ErrorFrame>
  );
}
