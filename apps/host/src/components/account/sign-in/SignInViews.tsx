// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in views every place that signs in shows. Each screen returns its parts and leaves the frame to the layout:
// the window page and the sign-in modal each place the same parts their own way.

import { createSignal, For, Show, untrack, type Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ArrowRightIcon, CheckIcon, PhoneCheckIcon, QrCodeIcon, type IconProps } from '@dotli/ui/icons';
import { LogoSymbol } from '@dotli/ui/brand';
import { Button, ButtonLink, Chip, SectionLabel, Spinner, Well } from '@dotli/ui';
import type { ContinueOffer } from '../../../state/session-window.js';
import { AccountAvatar } from '../AccountAvatar.js';
import { offeredAccountName } from '../account-names.js';
import type { DrawQr } from '../qr-code.js';
import { PairingQr } from './PairingQr.js';
import s from './SignInViews.module.css';

/**
 * What a screen gives the layout that places it. The buttons come alone, without a stack, and the layout sets them in
 * its own stack or row, in its own order.
 */
export type SignInParts = {
  /** What the view is, for a layout that heads the view itself. */
  title: string;
  content: JSX.Element;
  /** A control that shows more of the view rather than answering it. */
  reveal?: JSX.Element;
  /** The view's answers other than its way out. */
  actions?: JSX.Element;
  /** The view's own Cancel or Close. Without one, the layout gives the view its own way out, or none. */
  dismiss?: JSX.Element;
  note?: JSX.Element;
};

/** The colour a status icon is drawn in. `strong` is the text's own, for a step that is neither good nor bad. */
export type SignInTone = 'ok' | 'err' | 'warn' | 'idle' | 'strong';

/** What heads a status: a bare thin-line icon in its tone, or a spinner while something is under way. */
export type StatusMark = { icon: Component<IconProps>; tone: SignInTone } | 'spinner';

/** A button in a screen's stack. */
export type SignInAction = {
  label: string;
  onPress: () => void;
  /** The one main action. */
  primary?: boolean | undefined;
  /** The view's own Cancel or Close. */
  dismisses?: boolean | undefined;
  /** Leads the label. */
  icon?: Component<IconProps> | undefined;
  /** Follows the label. */
  trailingIcon?: Component<IconProps> | undefined;
  /** Read as the button renders, so a getter keeps it current. */
  disabled?: boolean | undefined;
  id?: string | undefined;
  testId?: string | undefined;
};

/**
 * The heading a screen takes: `1` when the screen heads its page with its own title, or `layout` when the layout
 * heads the view and the screen shows no title of its own.
 */
export type HeadingLevel = 1 | 'layout';

/** The id and test id of a pairing view's own Cancel or Close, which pages and tests find whatever the view. */
export const SIGN_IN_CLOSE_ID = 'auth-modal-close';

// Lists the current Polkadot App store listings for phones without the app.
const GET_APP_URL = 'https://docs.polkadot.com/apps/';

const SIGN_IN_TITLE = 'Sign in with Polkadot App';
const APPROVE_TITLE = 'Approve in Polkadot App';

// The props the primitives take are exact, so an id given as undefined is left out.
function idProps(id: string | undefined, testId: string | undefined): { id?: string; testId?: string } {
  return { ...(id === undefined ? {} : { id }), ...(testId === undefined ? {} : { testId }) };
}

/** A title of the screen's own, heading the page as its `h1`. */
export function Title(props: {
  id?: string | undefined;
  testId?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <h1 class={s['title']} id={props.id} data-testid={props.testId}>
      {props.children}
    </h1>
  );
}

/**
 * The title over its body, or the body alone when the layout heads the view. The body may carry its own markup, such
 * as an alert, so it sits in a block.
 */
function Heading(props: {
  level: HeadingLevel;
  title: string;
  titleId?: string | undefined;
  titleTestId?: string | undefined;
  body: JSX.Element;
  bodyId?: string | undefined;
  bodyTestId?: string | undefined;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div class={s['heading']}>
      <Show when={props.level !== 'layout'}>
        <Title id={props.titleId} testId={props.titleTestId}>
          {props.title}
        </Title>
      </Show>
      <div class={s['body']} id={props.bodyId} data-testid={props.bodyTestId}>
        {props.body}
      </div>
      {props.children}
    </div>
  );
}

function ActionButtons(props: { actions: readonly SignInAction[] }): JSX.Element {
  return (
    <For each={props.actions}>
      {action => {
        const Lead = action.icon;
        const Trail = action.trailingIcon;
        const ids = idProps(action.id, action.testId);
        return (
          <Button
            {...ids}
            variant={action.primary === true ? 'primary' : 'secondary'}
            block
            disabled={action.disabled === true}
            onClick={() => {
              action.onPress();
            }}
          >
            {Lead !== undefined && <Lead class={s['buttonIcon']} />}
            {action.label}
            {Trail !== undefined && <Trail class={s['buttonIcon']} />}
          </Button>
        );
      }}
    </For>
  );
}

/** A view's buttons as parts: its way out apart from its other answers, each present only when it has a button. */
export function answerParts(actions: readonly SignInAction[]): Pick<SignInParts, 'actions' | 'dismiss'> {
  const answers = actions.filter(action => action.dismisses !== true);
  const ways = actions.filter(action => action.dismisses === true);
  return {
    ...(answers.length === 0 ? {} : { actions: <ActionButtons actions={answers} /> }),
    ...(ways.length === 0 ? {} : { dismiss: <ActionButtons actions={ways} /> }),
  };
}

function Steps(): JSX.Element {
  return (
    <ol class={s['steps']}>
      <li class={s['step']}>
        <span class={s['stepNumber']} aria-hidden="true">
          1
        </span>
        Scan QR code with your phone
      </li>
      <li class={s['step']}>
        <span class={s['stepNumber']} aria-hidden="true">
          2
        </span>
        Approve
      </li>
    </ol>
  );
}

export type PairingScreenProps = {
  /** The pairing deeplink, null while it is being made. Read as it changes, so the code comes in on this screen. */
  payload: string | null;
  /** The page the sign-in is for, null for a sign-in of its own. */
  host: string | null;
  /** The product's own words for why it asks. */
  reason: string | null;
  /** A phone has no second device to scan with, so it leads with the deeplink. */
  mobile: boolean;
  level?: HeadingLevel | undefined;
  /** Takes focus before a pressed control is replaced, so it never drops to the page. */
  holdFocus?: (() => void) | undefined;
  /** Without one, the `qrcode` chunk draws the code. */
  drawQr?: DrawQr | undefined;
};

/**
 * The code to scan, or on a phone the deeplink with the code one press away. Whether it is a phone is read once, so
 * the layout rebuilds the screen if that changes.
 */
export function PairingScreen(props: PairingScreenProps): SignInParts {
  const phone = untrack(() => props.mobile);
  const [revealed, setRevealed] = createSignal(false);
  const scanning = (): boolean => !phone || revealed();

  const body = (): string => {
    if (props.payload === null) {
      return 'Getting a sign-in code ready.';
    }
    const ask = scanning() ? 'Scan the code' : 'Approve in the app';
    const to = props.host === null ? 'sign in' : `continue to ${props.host}`;
    return `${ask} to ${to}. One sign-in works across every app.`;
  };

  const reveal = (): void => {
    // The button goes as the code comes in.
    props.holdFocus?.();
    setRevealed(true);
  };

  /**
   * A phone answers by opening the app, and can still show the code to scan from another phone. The label stands
   * alone, so it fits an answer half as wide as a prompt.
   */
  function phoneParts(): Pick<SignInParts, 'actions' | 'reveal'> {
    return {
      actions: (
        <Show
          when={props.payload}
          fallback={
            <Button variant="primary" block disabled>
              Open Polkadot App
            </Button>
          }
        >
          {payload => (
            <ButtonLink href={payload()} variant="primary" block testId="auth-modal-open-app">
              Open Polkadot App
            </ButtonLink>
          )}
        </Show>
      ),
      reveal: (
        <Show when={!revealed()}>
          <Button block testId="auth-modal-qr-toggle" onClick={reveal}>
            <QrCodeIcon class={s['buttonIcon']} />
            Scan from another phone
          </Button>
        </Show>
      ),
    };
  }

  return {
    title: SIGN_IN_TITLE,
    content: (
      <div class={s['screen']} data-layout={scanning() ? 'scan' : 'app'}>
        <Show when={!scanning()}>
          <LogoSymbol class={s['symbol']} height={44} />
        </Show>
        <Heading
          level={props.level ?? 1}
          title={SIGN_IN_TITLE}
          titleId="auth-modal-title"
          body={body()}
          bodyId="auth-modal-hint"
          bodyTestId="auth-modal-hint"
        >
          <p class={s['reason']} id="auth-modal-reason" data-testid="auth-modal-reason" hidden={props.reason === null}>
            {props.reason ?? ''}
          </p>
        </Heading>
        <PairingQr payload={props.payload} shown={scanning()} link={phone} drawQr={props.drawQr} />
        <Show when={scanning() && props.payload !== null}>
          <Steps />
        </Show>
      </div>
    ),
    ...(phone ? phoneParts() : {}),
    note: (
      <p class={s['note']}>
        No Polkadot App yet?{' '}
        <a class={s['link']} id="auth-modal-get-app" href={GET_APP_URL} target="_blank" rel="noopener noreferrer">
          {phone ? 'Get it' : 'Get it for iPhone or Android'}
        </a>
      </p>
    ),
  };
}

export type ApprovingScreenProps = {
  /** What closes once the user approves, as the layout knows it: the window, or the dialog. */
  closesCopy: string;
  onCancel: () => void;
  level?: HeadingLevel | undefined;
};

/** The code was scanned and the phone asks the user to approve. */
export function ApprovingScreen(props: ApprovingScreenProps): SignInParts {
  return {
    title: APPROVE_TITLE,
    content: (
      <div class={s['screen']} data-tone="strong">
        <PhoneCheckIcon class={s['markIcon']} />
        <Heading
          level={props.level ?? 1}
          title={APPROVE_TITLE}
          titleId="auth-modal-title"
          body={`Check your phone and approve the sign-in. ${props.closesCopy}`}
        />
        <div class={s['progress']} role="status">
          <Spinner class={s['progressSpinner']} testId="auth-modal-spinner" />
          Signing in…
        </div>
      </div>
    ),
    ...answerParts([
      {
        label: 'Cancel',
        onPress: () => {
          props.onCancel();
        },
        dismisses: true,
        id: SIGN_IN_CLOSE_ID,
        testId: SIGN_IN_CLOSE_ID,
      },
    ]),
  };
}

export type StatusScreenProps = {
  /** Without one, the title leads. */
  mark?: StatusMark | undefined;
  title: string;
  body: JSX.Element;
  /** The raw reason, kept for bug reports. */
  detail?: string | undefined;
  actions?: readonly SignInAction[] | undefined;
  level?: HeadingLevel | undefined;
  testId?: string | undefined;
  /** The title's id, which names the dialog. */
  titleId?: string | undefined;
  titleTestId?: string | undefined;
  spinnerTestId?: string | undefined;
  detailTestId?: string | undefined;
};

/** Where a sign-in stands: under way, done, failed or asking for a press. */
export function StatusScreen(props: StatusScreenProps): SignInParts {
  const icon = (): Exclude<StatusMark, 'spinner'> | undefined =>
    typeof props.mark === 'object' ? props.mark : undefined;
  return {
    title: untrack(() => props.title),
    content: (
      <div class={s['screen']} data-tone={icon()?.tone} data-testid={props.testId}>
        <Show when={props.mark === 'spinner'}>
          <Spinner class={s['markSpinner']} {...idProps(undefined, props.spinnerTestId)} />
        </Show>
        <Show when={icon()} keyed>
          {mark => <mark.icon class={s['markIcon']} />}
        </Show>
        <Heading
          level={props.level ?? 1}
          title={props.title}
          titleId={props.titleId}
          titleTestId={props.titleTestId}
          body={props.body}
        />
        <Show when={props.detail !== undefined && props.detail.length > 0}>
          <Well class={s['detail']} {...idProps(undefined, props.detailTestId)}>
            {props.detail}
          </Well>
        </Show>
      </div>
    ),
    // Whether there are actions decides whether the layout gets any, once.
    ...untrack(() => answerParts(props.actions ?? [])),
  };
}

export type ContinueScreenProps = {
  offer: ContinueOffer;
  /** The page the sign-in is for, null for a sign-in of its own. */
  host: string | null;
  /** What failed of the last step the user asked for. */
  failure?: string | null | undefined;
  onContinue: () => void;
  onUseAnotherAccount: () => void;
};

/** An account is already signed in: go on with it, or sign in with another one. */
export function ContinueScreen(props: ContinueScreenProps): SignInParts {
  const local = (): boolean => props.offer.wallet === 'local';
  return {
    title: 'Already signed in',
    content: (
      <div class={s['screen']} data-testid="session-window-continue">
        <div class={s['account']}>
          <SectionLabel text="Already signed in" />
          <AccountAvatar
            session={props.offer.account ?? undefined}
            size="lg"
            local={local()}
            decorative
            testId="session-window-avatar"
          />
          <Title testId="session-window-title">{offeredAccountName(props.offer)}</Title>
          <Show when={local()}>
            <Chip tone="warn" testId="session-window-local">
              Local account
            </Chip>
          </Show>
        </div>
        <Well class={s['grant']} testId="session-window-note">
          <CheckIcon class={s['grantIcon']} />
          <span>{`${props.host ?? 'Apps'} can ask this account to sign. Polkadot App asks you before each one.`}</span>
        </Well>
        <Show when={props.failure}>
          {failure => (
            <p class={s['failure']} role="alert" data-testid="session-window-failure">
              {failure()}
            </p>
          )}
        </Show>
      </div>
    ),
    ...answerParts([
      {
        label: untrack(() => (props.host === null ? 'Continue' : `Continue to ${props.host}`)),
        primary: true,
        trailingIcon: ArrowRightIcon,
        onPress: () => {
          props.onContinue();
        },
        testId: 'session-window-continue-button',
      },
      {
        label: 'Use another account',
        onPress: () => {
          props.onUseAnotherAccount();
        },
        testId: 'session-window-another',
      },
    ]),
  };
}
