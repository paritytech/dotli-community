// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which screen each view of the session window shows, and what its buttons ask of the window, of a site's round or of
// the site list.

import { For, merge, omit, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Button, SectionLabel, Spinner, Stack, Well } from '@dotli/ui';
import { BanIcon, CheckIcon, CircleAlertIcon, CircleCheckIcon, PhoneCheckIcon } from '@dotli/ui/icons';
import type { DisplayAccount } from '../siteSignIn/index.js';
import type { DisplayCall } from '../siteSignIn/index.js';
import type { ListedSite, SiteListScreen } from '../siteSignIn/index.js';
import type { PairingView } from '../account/index.js';
import type {
  ContinueOffer,
  RedirectScreen,
  SiteWindowScreen,
  WindowFailure,
  WindowView,
} from './sessionWindowState.js';
import type { PhraseForm } from '../account/index.js';
import type { DrawQr } from '../account/index.js';
import { signInParts } from '../account/index.js';
import {
  ContinueScreen,
  SIGN_IN_CLOSE_ID,
  StatusScreen,
  type SignInAction,
  type SignInParts,
  type StatusMark,
} from '../account/index.js';
import s from './windowParts.module.css';

/**
 * What a window view stands for. A new step builds its screen anew, and what the screen held goes with it. The code
 * being made and the code to scan are one pairing step.
 */
export type WindowStep =
  | { view: 'pairing'; pairing: PairingView }
  | { view: 'continue'; offer: ContinueOffer; phoneFailed: boolean }
  | { view: 'phrase'; form: PhraseForm }
  | { view: Exclude<WindowView, 'pairing' | 'continue' | 'phrase'> }
  | SiteWindowScreen
  | RedirectScreen
  | SiteListScreen;

/** What every window screen needs from the window. */
export type WindowPartsProps = {
  /** The page the window signs in for. */
  host: string | null;
  /** A step the user asked for that failed, said on the view it left. */
  failure: WindowFailure | null;
  /** The pairing deeplink on show, null while it is being made. */
  payload: string | null;
  /** A phone has no second device to scan with, so the pairing leads with the deeplink. */
  mobile: boolean;
  /** The user pressed Close on a view that only says where the window stands. */
  onClose: () => void;
  /** The user gave up on the round. */
  onCancel: () => void;
  onContinue: () => void;
  onUseAnotherAccount: () => void;
  /** Goes on to another account after the phone could not be told of the sign-out. */
  onGoOnWithoutPhone: () => void;
  /** Pairs again after a failed pairing, or decides again what to show after a step of the window's own failed. */
  onRetry: () => void;
  onClosePhrase: () => void;
  /** Loads the phrase form again after its chunk failed to load. */
  onReloadPhrase: () => void;
  /** Rejects when the wallet could not be saved, which the window already reported. */
  onImportPhrase: (phrase: string) => Promise<void>;
  isValidPhrase: (phrase: string) => boolean;
  /** Without one, the `qrcode` chunk draws the code. */
  drawQr?: DrawQr | undefined;
  /** Goes on with a site's sign-in from its consent view. */
  onConsent: () => void;
  /** Refuses the site from its consent view. */
  onDecline: () => void;
  /** Signs what a site's review shows. */
  onSiteConfirm: () => void;
  /** Runs a site's round again after a step of it failed. */
  onSiteRetry: () => void;
  /** The user gave up on a site's round. */
  onSiteCancel: () => void;
  /** Forgets the site of `token` from the site list. */
  onRevoke: (token: string) => void;
  /** Reads the site list again after its read failed. */
  onSiteListRetry: () => void;
};

/** The views that only say where the window stands. */
type StatusView =
  | Extract<WindowView, 'connecting' | 'refused' | 'signing-out' | 'signed-out' | 'done-no-opener'>
  | RedirectScreen['view'];

type StatusCopy = {
  mark: StatusMark;
  title: string;
  body: string;
  /** The label of Close, where it is offered. A sign-out under way closes itself or says when it is done. */
  close?: string;
};

const STATUS_COPY: Record<StatusView, StatusCopy> = {
  connecting: {
    mark: 'spinner',
    title: 'Connecting',
    body: 'Waiting for the page that opened this window.',
    close: 'Close',
  },
  refused: {
    mark: { icon: BanIcon },
    title: 'Sign-in is not available for this page',
    body: 'This window does not sign in pages at that address.',
    close: 'Close',
  },
  'signing-out': {
    mark: 'spinner',
    title: 'Signing out',
    body: 'Signing you out of Polkadot App.',
  },
  'signed-out': {
    mark: { icon: CircleCheckIcon, tone: 'ok' },
    title: "You're signed out",
    body: 'Signed out of every app. Polkadot App is being told to forget this browser.',
    close: 'Close',
  },
  'done-no-opener': {
    mark: { icon: CircleCheckIcon, tone: 'ok' },
    title: "You're signed in",
    body: 'Return to the app.',
    close: 'Close',
  },
  'site-not-allowed': {
    mark: { icon: BanIcon },
    title: 'This sign-in was stopped',
    body: 'The site asked to send you back to an address it does not allow. Nothing was sent to the site.',
    close: 'Close',
  },
  'site-unsupported': {
    mark: { icon: CircleAlertIcon, tone: 'warn' },
    title: 'This browser cannot finish this sign-in',
    body: 'Try again in another browser.',
    close: 'Close',
  },
};

/** Said on Continue, which stays on show. The phone's failure has a view of its own. */
const FAILURE_COPY: Record<Exclude<WindowFailure, 'phone'>, string> = {
  'sign-out': 'Could not sign out of this account.',
  step: 'Something went wrong. Try again.',
};

function statusParts(view: StatusView, props: WindowPartsProps): SignInParts {
  const copy = STATUS_COPY[view];
  const close: SignInAction[] =
    copy.close === undefined
      ? []
      : [
          {
            label: copy.close,
            onPress: () => {
              props.onClose();
            },
            dismisses: true,
            testId: 'session-window-close',
          },
        ];
  return StatusScreen({
    mark: copy.mark,
    title: copy.title,
    body: copy.body,
    actions: close,
    testId: 'session-window-status',
    titleTestId: 'session-window-title',
    spinnerTestId: 'session-window-spinner',
  });
}

/** The account's sign-out let it go from the store, but the phone was not told, so no account is offered. */
function phoneNotToldParts(props: WindowPartsProps): SignInParts {
  return StatusScreen({
    mark: { icon: CircleAlertIcon, tone: 'warn' },
    title: 'Not signed out of Polkadot App',
    body: (
      <span role="alert" data-testid="session-window-failure">
        Polkadot App could not be told. It still lists this browser.
      </span>
    ),
    actions: [
      {
        label: 'Try again',
        primary: true,
        onPress: () => {
          props.onUseAnotherAccount();
        },
        testId: 'session-window-another-retry',
      },
      {
        label: 'Use another account anyway',
        onPress: () => {
          props.onGoOnWithoutPhone();
        },
        testId: 'session-window-go-on',
      },
    ],
    testId: 'session-window-phone-failed',
    titleTestId: 'session-window-title',
  });
}

/** A step of the window's own failed where its view could not go on. Try again asks `retry`. */
function stepFailedParts(props: WindowPartsProps, retry: () => void): SignInParts {
  return StatusScreen({
    mark: { icon: CircleAlertIcon, tone: 'err' },
    title: 'Something went wrong',
    body: 'This window could not go on with the sign-in. Try again.',
    actions: [
      {
        label: 'Try again',
        primary: true,
        onPress: retry,
        testId: 'auth-modal-retry',
      },
      {
        label: 'Cancel',
        onPress: () => {
          props.onCancel();
        },
        dismisses: true,
        id: SIGN_IN_CLOSE_ID,
        testId: SIGN_IN_CLOSE_ID,
      },
    ],
    testId: 'auth-modal-failure',
    titleTestId: 'session-window-title',
  });
}

function pairingParts(pairing: PairingView, props: WindowPartsProps): SignInParts {
  return signInParts(
    pairing,
    merge(props, {
      reason: null,
      closesCopy: "This window closes when you're done.",
      onClose: () => {
        props.onCancel();
      },
    }),
  );
}

function continueParts(offer: ContinueOffer, props: WindowPartsProps): SignInParts {
  return ContinueScreen(
    merge(omit(props, 'failure'), {
      offer,
      get failure() {
        const failure = props.failure;
        return failure === null || failure === 'phone' ? null : FAILURE_COPY[failure];
      },
    }),
  );
}

/**
 * The phrase form, which the debug panel's wallet tab opens the window at. Its chunk loads with the view, which says it
 * is connecting until then.
 */
function phraseParts(form: PhraseForm, props: WindowPartsProps): SignInParts {
  if (form === 'loading') {
    return statusParts('connecting', props);
  }
  if (form === 'failed') {
    return stepFailedParts(props, () => {
      props.onReloadPhrase();
    });
  }
  return form.PhraseScreen({
    isValid: phrase => props.isValidPhrase(phrase),
    onImport: phrase => props.onImportPhrase(phrase),
    onBack: () => {
      props.onClosePhrase();
    },
    backLabel: 'Back',
    testId: 'session-window-phrase',
  });
}

/** What a site gets once the user consents. */
const SITE_GETS = ['Your username', 'The right to ask you to sign transactions, each confirmed again'];

/** The way out of a site's round, which tells the site the user left. */
function siteCancel(props: WindowPartsProps): SignInAction {
  return {
    label: 'Cancel',
    onPress: () => {
      props.onSiteCancel();
    },
    dismisses: true,
    testId: 'session-window-site-cancel',
  };
}

/**
 * A site asks to sign in: the Sign in with Polkadot header, then the site's full origin and the registrable domain its
 * group covers when it has one, then what the site gets, then Continue and Cancel.
 */
function consentParts(origin: string, group: string | null, props: WindowPartsProps): SignInParts {
  const parts = StatusScreen({
    title: 'Sign in with Polkadot',
    body: (
      <>
        <span class={s['origin']} data-testid="session-window-site">
          {origin}
        </span>
        {group === null ? null : (
          <span class={[s['lead'], s['group']]} data-testid="session-window-group">
            and every site of {group} that shares this sign-in
          </span>
        )}
      </>
    ),
    actions: [
      {
        label: 'Continue',
        primary: true,
        onPress: () => {
          props.onConsent();
        },
        testId: 'session-window-consent-button',
      },
      {
        label: 'Cancel',
        onPress: () => {
          props.onDecline();
        },
        dismisses: true,
        testId: 'session-window-decline',
      },
    ],
    testId: 'session-window-consent',
    titleTestId: 'session-window-title',
  });
  return {
    ...parts,
    content: (
      <>
        {parts.content}
        <Stack>
          <SectionLabel as="h2" text="This site gets" />
          <Well layout="list">
            <div role="list" data-testid="session-window-site-gets">
              <For each={SITE_GETS}>
                {line => (
                  <div role="listitem" class={s['gets']}>
                    <CheckIcon class={s['getsIcon']} />
                    {line}
                  </div>
                )}
              </For>
            </div>
          </Well>
        </Stack>
      </>
    ),
  };
}

/** What a site asks for, which names its views. */
type SiteRoute = Extract<WindowStep, { view: 'site-failed' }>['route'];

/** The site's full origin over what the view says of it. */
function SiteBody(props: { origin: string; lead: string }): JSX.Element {
  return (
    <>
      <span class={s['origin']}>{props.origin}</span>
      <span class={s['lead']}>{props.lead}</span>
    </>
  );
}

/** What a site's round under way says. */
type SiteWaitCopy = {
  title: string;
  lead: string;
  /** Set where Polkadot App asks the user, which the phone heads and a spinner beside it waits on. */
  phone?: string;
};

const SITE_WAIT_COPY = {
  'site-signing-auth': { title: 'Signing in', lead: 'This takes a moment.' },
  'site-signing-sign': { title: 'Preparing the transaction', lead: 'Polkadot App asks you to approve it next.' },
  'site-sharing': {
    title: 'Approve in Polkadot App',
    lead: 'Approve sharing your account with this site on your phone.',
    phone: 'Waiting for Polkadot App…',
  },
  'site-approving': {
    title: 'Approve the transaction in Polkadot App',
    lead: 'Check your phone and approve the transaction.',
    phone: 'Waiting for Polkadot App…',
  },
} satisfies Record<string, SiteWaitCopy>;

/**
 * A site's round under way: a spinner while it waits on the network, or the phone while it waits on Polkadot App, with
 * the spinner beside what it waits for.
 */
function siteWaitParts(copy: SiteWaitCopy, origin: string, props: WindowPartsProps): SignInParts {
  return StatusScreen({
    mark: copy.phone === undefined ? 'spinner' : { icon: PhoneCheckIcon },
    title: copy.title,
    body: <SiteBody origin={origin} lead={copy.lead} />,
    progress: copy.phone,
    actions: [siteCancel(props)],
    testId: 'session-window-status',
    titleTestId: 'session-window-title',
    spinnerTestId: 'session-window-spinner',
  });
}

/**
 * A site asks for a transaction: what it asks heads the view, the site's full origin under it, then the call by name
 * and each argument with its value on a line of its own, as text and never as markup.
 */
function siteReviewParts({
  origin,
  call,
  account,
  props,
}: {
  origin: string;
  call: DisplayCall;
  account: DisplayAccount;
  props: WindowPartsProps;
}): SignInParts {
  const parts = StatusScreen({
    title: 'Sign transaction',
    body: <SiteBody origin={origin} lead={`asks you to sign with your ${account.product} account.`} />,
    actions: [
      {
        label: 'Sign with Polkadot App',
        primary: true,
        onPress: () => {
          props.onSiteConfirm();
        },
        testId: 'session-window-site-sign',
      },
      siteCancel(props),
    ],
    testId: 'session-window-review',
    titleTestId: 'session-window-title',
  });
  return {
    ...parts,
    content: (
      <>
        {parts.content}
        {/* A long call scrolls in its own box, so the answers stay in view. */}
        <div class={s['call']} tabindex="0" role="region" aria-label="Transaction">
          <Well layout="list" testId="session-window-call">
            {/* The call's name shows in the case the chain spells it. */}
            <span class={s['callName']} role="heading" aria-level={2}>
              {call.name}
            </span>
            <For each={call.args}>
              {arg => (
                <div class={s['arg']} data-testid="session-window-call-arg">
                  <span class={s['argName']} data-testid="session-window-call-arg-name">
                    {arg.name}
                  </span>
                  <span class={s['argValue']} data-testid="session-window-call-arg-value">
                    {arg.value}
                  </span>
                </div>
              )}
            </For>
          </Well>
        </div>
      </>
    ),
  };
}

/** A step of a site's round failed. Try again, where a step may be tried again, runs the round again. */
function siteFailedParts({
  origin,
  route,
  retry,
  props,
}: {
  origin: string;
  route: SiteRoute;
  retry: boolean;
  props: WindowPartsProps;
}): SignInParts {
  const tryAgain: SignInAction = {
    label: 'Try again',
    primary: true,
    onPress: () => {
      props.onSiteRetry();
    },
    testId: 'session-window-site-retry',
  };
  return StatusScreen({
    mark: { icon: CircleAlertIcon, tone: 'err' },
    title: route === 'auth' ? 'The sign-in could not finish' : 'The transaction could not finish',
    body: (
      <SiteBody
        origin={origin}
        lead={route === 'auth' ? 'You are not signed in to this site.' : 'Nothing was signed.'}
      />
    ),
    // With nothing left to try, the round is over, so its way out closes rather than cancels.
    actions: retry ? [tryAgain, siteCancel(props)] : [{ ...siteCancel(props), label: 'Close' }],
    testId: 'session-window-status',
    titleTestId: 'session-window-title',
  });
}

const SITE_LIST_TITLE = 'Sites you signed in to';

/** Lets an origin wrap after each dot and after its scheme, rather than in the middle of a label. */
function breakableOrigin(origin: string): JSX.Element {
  return origin.split(/(?<=\/\/|\.)/).flatMap((part, index) => (index === 0 ? [part] : [<wbr />, part]));
}

/** A date as the site list writes it, in the reader's locale. */
function listDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * One site of the list: its full origin on a line of its own, which wraps rather than cuts off, since two origins may
 * differ only in their port, then when it was first and last used, with Revoke beside them. A group heads with its
 * registrable domain, then shows each of its origins so, and Revoke forgets the whole group.
 */
function ListedSiteRows(props: { site: ListedSite; onRevoke: (token: string) => void }): JSX.Element {
  const name = (): string => props.site.group?.registrable ?? props.site.origin;
  return (
    <div class={s['site']} data-testid="session-window-site">
      <div class={s['siteText']}>
        <Show
          when={props.site.group}
          fallback={
            <span class={s['siteName']} data-testid="session-window-site-origin">
              {breakableOrigin(props.site.origin)}
            </span>
          }
        >
          {group => (
            <>
              <span class={s['siteName']} role="heading" aria-level={2} data-testid="session-window-site-group">
                {group().registrable}
              </span>
              <For each={group().origins}>
                {origin => (
                  <span class={s['siteOrigin']} data-testid="session-window-site-origin">
                    {breakableOrigin(origin)}
                  </span>
                )}
              </For>
            </>
          )}
        </Show>
        <div class={s['siteUses']}>
          <span class={s['siteUse']}>{`Since ${listDate(props.site.firstUsedAt)}`}</span>
          <span aria-hidden="true">{' · '}</span>
          <span class={s['siteUse']}>{`Last used ${listDate(props.site.lastUsedAt)}`}</span>
        </div>
      </div>
      <Button
        size="sm"
        aria-label={`Revoke ${name()}`}
        testId="session-window-site-revoke"
        onClick={() => {
          props.onRevoke(props.site.token);
        }}
      >
        Revoke
      </Button>
    </div>
  );
}

/** The sites the user signed in to, newest use first, each with Revoke, or a line that there are none. */
function siteListParts(sites: readonly ListedSite[], props: WindowPartsProps): SignInParts {
  const empty = sites.length === 0;
  const parts = StatusScreen({
    title: SITE_LIST_TITLE,
    body: empty ? <span data-testid="session-window-sites-empty">No site uses your Polkadot sign-in.</span> : null,
    testId: 'session-window-status',
    titleTestId: 'session-window-title',
  });
  if (empty) {
    return parts;
  }
  return {
    ...parts,
    content: (
      <>
        {parts.content}
        <Well layout="list" testId="session-window-sites">
          <For each={sites}>
            {site => (
              <ListedSiteRows
                site={site}
                onRevoke={token => {
                  props.onRevoke(token);
                }}
              />
            )}
          </For>
        </Well>
      </>
    ),
  };
}

/** The list waits for its first read of the grants, under its heading where the sites will show. */
function siteListLoadingParts(): SignInParts {
  const parts = StatusScreen({
    title: SITE_LIST_TITLE,
    body: null,
    testId: 'session-window-status',
    titleTestId: 'session-window-title',
  });
  return {
    ...parts,
    content: (
      <>
        {parts.content}
        <div class={s['listLoading']} role="status" aria-label="Reading your sites">
          <Spinner testId="session-window-spinner" />
        </div>
      </>
    ),
  };
}

/** The grants could not be read, so the list says so in place of the sites. Try again reads them again. */
function siteListFailedParts(props: WindowPartsProps): SignInParts {
  return StatusScreen({
    mark: { icon: CircleAlertIcon, tone: 'err' },
    title: 'Could not load your sites',
    body: (
      <span role="alert" data-testid="session-window-failure">
        The list of sites you signed in to could not be read.
      </span>
    ),
    actions: [
      {
        label: 'Try again',
        primary: true,
        onPress: () => {
          props.onSiteListRetry();
        },
        testId: 'session-window-sites-retry',
      },
    ],
    testId: 'session-window-status',
    titleTestId: 'session-window-title',
  });
}

/** The screen for a step of the window. Each call builds the screen anew, so call it once per step. */
export function windowParts(step: WindowStep, props: WindowPartsProps): SignInParts {
  switch (step.view) {
    case 'pairing':
      return pairingParts(step.pairing, props);
    case 'continue':
      return step.phoneFailed ? phoneNotToldParts(props) : continueParts(step.offer, props);
    case 'failed':
      return stepFailedParts(props, () => {
        props.onRetry();
      });
    case 'phrase':
      return phraseParts(step.form, props);
    case 'consent':
      return consentParts(step.origin, step.group, props);
    case 'site-signing':
      return siteWaitParts(
        step.route === 'auth' ? SITE_WAIT_COPY['site-signing-auth'] : SITE_WAIT_COPY['site-signing-sign'],
        step.origin,
        props,
      );
    case 'site-review':
      return siteReviewParts({ origin: step.origin, call: step.call, account: step.account, props });
    // The user is asked to open Polkadot App for the site account.
    case 'site-sharing':
    case 'site-approving':
      return siteWaitParts(SITE_WAIT_COPY[step.view], step.origin, props);
    case 'site-failed':
      return siteFailedParts({ origin: step.origin, route: step.route, retry: step.retry, props });
    case 'sites':
      return siteListParts(step.sites, props);
    case 'sites-loading':
      return siteListLoadingParts();
    case 'sites-failed':
      return siteListFailedParts(props);
    case 'connecting':
    case 'refused':
    case 'signing-out':
    case 'signed-out':
    case 'done-no-opener':
    case 'site-not-allowed':
    case 'site-unsupported':
      return statusParts(step.view, props);
  }
}
