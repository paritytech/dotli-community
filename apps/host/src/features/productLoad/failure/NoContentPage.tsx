// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page for a name that resolved to no content, in the error page's frame.

import type { JSX } from '@solidjs/web';
import { ErrorActions, ErrorDetail, ErrorFrame } from '@dotli/ui';
import { SEARCH_AGAIN_BTN_LABEL } from './errorCopy.js';
import { SearchXIcon } from './SearchXIcon.js';
import s from './NoContentPage.module.css';

/** The domain sits on its own chip so the visitor can scan it for a typo. */
export function NoContentPage(props: {
  label: string;
  tld: string;
  standalone: boolean;
  onSearchAgain: () => void;
}): JSX.Element {
  return (
    <ErrorFrame standalone={props.standalone} class={s['unreached']} icon={SearchXIcon} title="No app with this name">
      {/* The chip stays inside the sentence, so a screen reader hears it as one. */}
      <ErrorDetail class={s['line']}>
        Check the name for a typo:{' '}
        <span class={s['domain']} data-testid="error-page-domain">
          <span class={s['domainHost']}>{props.label}</span>
          <span class={s['domainTld']}>{props.tld}</span>
        </span>
      </ErrorDetail>
      <ErrorActions actions={[{ label: SEARCH_AGAIN_BTN_LABEL, onClick: props.onSearchAgain }]} />
    </ErrorFrame>
  );
}
