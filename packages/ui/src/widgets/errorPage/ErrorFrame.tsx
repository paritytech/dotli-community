// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, onSettled, Show, untrack, type Component } from 'solid-js';
import { dynamic, type JSX } from '@solidjs/web';
import type { IconProps } from '../../icons.js';
import { arrangeErrorActions, type ArrangedAction, type ErrorAction } from './arrangeErrorActions.js';
import s from './ErrorPage.module.css';

export type ErrorFrameProps = {
  standalone: boolean;
  /** On the centred column, for a screen's own layout of what sits under the title. */
  class?: string | undefined;
  /** Drawn in the circle above the title. */
  icon: Component<IconProps>;
  /** Tints the circle as a warning. */
  warning?: boolean | undefined;
  title: string;
  /**
   * The title takes focus as the screen shows, without a tab stop. For a screen that replaced the control the visitor
   * used, so a screen reader announces the new screen and the actions come next in tab order.
   */
  focusTitle?: boolean | undefined;
  children?: JSX.Element;
};

/** The error page's frame: a centred column under an icon and a title. */
export function ErrorFrame(props: ErrorFrameProps): JSX.Element {
  const Icon = dynamic(() => props.icon);
  let title: HTMLHeadingElement | undefined;
  onSettled(() => {
    if (untrack(() => props.focusTitle) === true) {
      title?.focus();
    }
  });
  return (
    <div class={[s['page'], props.standalone ? s['standalone'] : undefined]} data-testid="error-page">
      <div class={[s['inner'], props.class]}>
        <div
          class={s['glyph']}
          data-testid="error-page-glyph"
          aria-hidden="true"
          data-warning={props.warning === true ? '' : undefined}
        >
          <Icon size={24} class={s['glyphIcon']} testId="error-page-icon" />
        </div>
        <h1
          ref={el => {
            title = el;
          }}
          class={s['title']}
          data-testid="error-page-title"
          tabindex={props.focusTitle === true ? -1 : undefined}
        >
          {props.title}
        </h1>
        {props.children}
      </div>
    </div>
  );
}

/** The line under the title. */
export function ErrorDetail(props: { class?: string | undefined; children?: JSX.Element }): JSX.Element {
  return (
    <p class={[s['detail'], props.class]} data-testid="error-page-detail">
      {props.children}
    </p>
  );
}

function ActionIcon(props: { icon: Component<IconProps> }): JSX.Element {
  const Icon = dynamic(() => props.icon);
  return (
    <span class={s['retryIcon']} aria-hidden="true">
      <Icon class={s['actionIcon']} testId="error-page-action-icon" />
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

/** The error page's action row, the recommended action last. Renders nothing for an empty list. */
export function ErrorActions(props: { actions: readonly ErrorAction[] }): JSX.Element {
  const arranged = (): ArrangedAction[] => arrangeErrorActions(props.actions);
  return (
    <Show when={arranged().length > 0}>
      <div class={s['actions']} data-testid="error-page-actions">
        <For each={arranged()}>{item => <ActionButton arranged={item} />}</For>
      </div>
    </Show>
  );
}
