// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Bar.module.css';

/** A strip across the top of a pane, holding its tabs, filters or a caption. */
export function Bar(props: {
  testId?: string | undefined;
  hidden?: boolean;
  /** Controls that may need more than one line. */
  wrap?: boolean;
  class?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={[s['bar'], props.wrap === true && s['wrap'], props.class]}
      data-testid={props.testId}
      hidden={props.hidden}
    >
      {props.children}
    </div>
  );
}
