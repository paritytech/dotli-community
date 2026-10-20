// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  AccountAccessReview,
  AccountAliasReview,
  CreateProofReview,
  CreateTransactionReview,
  IdentityDisclosureReview,
  PermissionDecision,
  PreimageSubmitReview,
  ProductSubtreeReview,
  ResourceAllocationReview,
  SignPayloadReview,
  SignRawReview,
  SignVrfReview,
  StatementStoreProductSignReview,
  UserConfirmation as UserConfirmationHost,
  UserConfirmationReview,
} from '@parity/truapi-host';
import type {
  AllocatableResource,
  DerivationIndex,
  HostSignPayloadData,
  ProductAccountId,
  RawPayload,
  RingLocationJunction,
} from '@parity/truapi';
import { withActiveTld } from '@dotli/config';
import { captureException, m, spans as S } from '@dotli/metrics';
import { log, toHex } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import type { BlockingModalScope } from '../blocking-modal-queue.js';
import type { ModalButton, ModalField, ModalHandoff, ModalView } from '@dotli/ui';
import { SignIcon } from '../../components/icons/SignIcon.js';
import { phoneWaitingView, WAITING_BACKGROUND } from '../../components/signing/phone-waiting-view.js';
import type { HostPrompts } from '../host-prompts.js';
import { phoneMetricOutcome } from '../phone-outcome.js';
import { phoneOutcomeNotice } from '../phone-outcome-notice.js';
import type { PhoneRequestTracker } from '../phone-requests.js';
import { phoneReviewMatch } from '../phone-review-match.js';

/** The prompts a confirmation asks through and tells its outcome on. */
type ConfirmationPrompts = Pick<HostPrompts, 'confirmPreimage' | 'confirmReview' | 'notify'>;

interface ConfirmationCopy {
  title: string;
  action: string;
  cancelAction?: string;
  icon?: ModalView<string>['icon'];
}

type ConfirmationField = ModalField;

type ConfirmationDecision = 'accepted' | 'accepted-once' | 'rejected' | 'dismissed';

/** The step an answered review hands its place to, if any. */
type ReviewHandoff = (decision: ConfirmationDecision) => ModalHandoff | undefined;

/** Keeps the prompt slot until `closed` settles. */
type HoldSlot = (closed: Promise<void>) => void;

/** PreimageSubmit gets its own modal. */
type ModalReview = Exclude<UserConfirmationReview, { tag: 'PreimageSubmit' }>;

function showConfirmationModal(
  label: string,
  copy: ConfirmationCopy,
  review: ModalReview,
  signal: AbortSignal,
  allowOnce: boolean,
  prompts: ConfirmationPrompts,
  handoff: ReviewHandoff | undefined,
): Promise<ConfirmationDecision> {
  const buttons: ModalButton<ConfirmationDecision>[] = [
    // Every cancel here rejects the core's request, so it is drawn destructive.
    {
      label: copy.cancelAction ?? 'Cancel',
      variant: 'danger',
      result: 'rejected',
    },
    allowOnce
      ? { label: 'Always allow', variant: 'secondary', result: 'accepted' }
      : { label: copy.action, variant: 'primary', result: 'accepted' },
  ];
  if (allowOnce) {
    buttons.push({
      label: 'Allow once',
      variant: 'primary',
      result: 'accepted-once',
    });
  }
  return prompts.confirmReview<ConfirmationDecision>(
    {
      ...(copy.icon === undefined ? {} : { icon: copy.icon }),
      title: copy.title,
      fields: confirmationDisplay(label, review).fields,
      buttons,
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
    },
    signal,
    handoff,
  );
}

function confirmationDisplay(label: string, review: ModalReview): { fields: ConfirmationField[] } {
  switch (review.tag) {
    case 'SignPayload':
      return { fields: createSignPayloadFields(label, review.value) };
    case 'SignRaw':
      return { fields: createSignRawFields(label, review.value) };
    case 'StatementStoreProductSign':
      return { fields: createStatementSignFields(label, review.value) };
    case 'SignVrf':
      return { fields: createSignVrfFields(review.value) };
    case 'CreateTransaction':
      return { fields: createTransactionFields(label, review.value) };
    case 'AccountAlias':
      return { fields: createRingContextFields(review.value) };
    case 'CreateProof':
      return { fields: createProofFields(review.value) };
    case 'AccountAccess':
      return { fields: createAccountAccessFields(review.value) };
    case 'IdentityDisclosure':
    case 'ProductSubtree':
      return { fields: createRequestingProductFields(review.value) };
    case 'ResourceAllocation':
      return { fields: createResourceAllocationFields(review.value) };
  }
}

function truncateHex(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function formatRawPayload(payload: RawPayload): string {
  return truncateHex(payload.tag === 'Bytes' ? payload.value.bytes : payload.value.payload);
}

function formatDerivationIndex(index: DerivationIndex): string {
  return index.tag === 'Index' ? String(index.value) : index.value;
}

function formatProductAccount(account: ProductAccountId): string {
  return `${account.dotNsIdentifier} / ${formatDerivationIndex(account.derivationIndex)}`;
}

/** A manifest `context` grant lets one product sign with another's account, so the prompt must say who asks. */
function withCallingProduct(
  fields: ConfirmationField[],
  callingProductId: string | undefined,
  account: ProductAccountId,
): ConfirmationField[] {
  if (callingProductId === undefined || callingProductId === account.dotNsIdentifier) {
    return fields;
  }
  return [{ label: 'Requesting product', value: callingProductId }, ...fields];
}

function createPayloadFields(app: string, signer: string, payload: HostSignPayloadData): ConfirmationField[] {
  return [
    { label: 'App', value: app },
    { label: 'Signer', value: signer },
    { label: 'Genesis Hash', value: payload.genesisHash, mono: true },
    { label: 'Call Data', value: truncateHex(payload.method), mono: true },
    { label: 'Version', value: String(payload.version) },
  ];
}

function createSignPayloadFields(label: string, review: SignPayloadReview): ConfirmationField[] {
  if (review.tag === 'Product') {
    const { callingProductId, request } = review.value;
    return withCallingProduct(
      createPayloadFields(label, formatProductAccount(request.account), request.payload),
      callingProductId,
      request.account,
    );
  }

  return createPayloadFields(label, review.value.signer, review.value.payload);
}

function createSignRawFields(label: string, review: SignRawReview): ConfirmationField[] {
  const signer =
    review.tag === 'Product' ? formatProductAccount(review.value.request.account) : review.value.request.signer;
  const base: ConfirmationField[] = [
    { label: 'App', value: label },
    { label: 'Signer', value: signer },
    {
      label: 'Message',
      value: formatRawPayload(review.value.request.payload),
      mono: true,
    },
  ];
  const fields =
    review.tag === 'Product'
      ? withCallingProduct(base, review.value.callingProductId, review.value.request.account)
      : base;
  // Without the <Bytes> watermark the signed bytes could be a valid
  // transaction, so the user has to be told before approving.
  if (!review.value.watermarked) {
    fields.push({
      label: 'Warning',
      value: 'Unprotected signature: may authorize transactions',
      warning: true,
    });
  }
  return fields;
}

function createTransactionFields(label: string, review: CreateTransactionReview): ConfirmationField[] {
  const payload = review.tag === 'Product' ? review.value.payload : review.value;
  const signer = review.tag === 'Product' ? formatProductAccount(review.value.payload.signer) : review.value.signer;

  const fields: ConfirmationField[] = [
    { label: 'App', value: label },
    { label: 'Signer', value: signer },
    { label: 'Genesis Hash', value: payload.genesisHash, mono: true },
    { label: 'Call Data', value: truncateHex(payload.callData), mono: true },
    { label: 'Tx Ext Version', value: String(payload.txExtVersion) },
  ];
  return review.tag === 'Product'
    ? withCallingProduct(fields, review.value.callingProductId, review.value.payload.signer)
    : fields;
}

function formatRingJunction(junction: RingLocationJunction): string {
  return `${junction.tag}(${String(junction.value)})`;
}

function createRingContextFields(review: AccountAliasReview | CreateProofReview): ConfirmationField[] {
  return [
    { label: 'Requesting product', value: review.callingProductId },
    { label: 'Context product', value: review.context.productId },
    {
      label: 'Context suffix',
      value: formatDerivationIndex(review.context.suffix),
      mono: true,
    },
    { label: 'Chain', value: review.ringLocation.chainId, mono: true },
    {
      label: 'Ring path',
      value: review.ringLocation.junctions.map(formatRingJunction).join(' / '),
    },
  ];
}

function createProofFields(review: CreateProofReview): ConfirmationField[] {
  return [...createRingContextFields(review), { label: 'Message', value: toHex(review.message), mono: true }];
}

function createStatementSignFields(label: string, review: StatementStoreProductSignReview): ConfirmationField[] {
  return withCallingProduct(
    [
      { label: 'App', value: label },
      { label: 'Signer', value: formatProductAccount(review.account) },
      {
        label: 'Statement',
        value: truncateHex(toHex(review.payload.subarray(0, 41))),
        mono: true,
      },
    ],
    review.callingProductId,
    review.account,
  );
}

function createSignVrfFields(review: SignVrfReview): ConfirmationField[] {
  return [
    { label: 'Requesting product', value: review.callingProductId },
    { label: 'Signer', value: formatProductAccount(review.request.account) },
    {
      label: 'Transcript label',
      value: review.request.transcriptLabel,
      mono: true,
    },
    { label: 'Transcript items', value: String(review.request.items.length) },
  ];
}

function createAccountAccessFields(review: AccountAccessReview): ConfirmationField[] {
  return [
    { label: 'Requesting product', value: review.requestingProductId },
    { label: 'Requested account', value: review.targetProductId },
  ];
}

function createRequestingProductFields(review: IdentityDisclosureReview | ProductSubtreeReview): ConfirmationField[] {
  return [{ label: 'Requesting product', value: review.productId }];
}

function formatResource(resource: AllocatableResource): string {
  return resource.tag === 'SmartContractAllowance'
    ? `SmartContractAllowance / ${formatDerivationIndex(resource.value)}`
    : resource.tag;
}

function createResourceAllocationFields(review: ResourceAllocationReview): ConfirmationField[] {
  return [
    { label: 'Requesting product', value: review.callingProductId },
    {
      label: 'Resources',
      value: review.resources.map(formatResource).join(', '),
    },
  ];
}

function confirmationCopy(review: ModalReview): ConfirmationCopy {
  switch (review.tag) {
    case 'SignPayload':
      return { title: 'Sign Transaction', action: 'Sign', icon: SignIcon };
    case 'SignRaw':
      return { title: 'Sign Message', action: 'Sign', icon: SignIcon };
    case 'StatementStoreProductSign':
      return { title: 'Sign Statement', action: 'Sign', icon: SignIcon };
    case 'SignVrf':
      return { title: 'Sign VRF Transcript', action: 'Sign', icon: SignIcon };
    case 'CreateTransaction':
      return { title: 'Sign Transaction', action: 'Sign', icon: SignIcon };
    case 'AccountAlias':
      return {
        title: 'Alias Permission',
        action: 'Allow',
        cancelAction: 'Deny',
      };
    case 'CreateProof':
      return {
        title: 'Proof Permission',
        action: 'Allow',
        cancelAction: 'Deny',
      };
    case 'AccountAccess':
      return {
        title: 'Account Access',
        action: 'Allow',
        cancelAction: 'Deny',
      };
    case 'IdentityDisclosure':
      return {
        title: 'Identity Disclosure',
        action: 'Allow',
        cancelAction: 'Deny',
      };
    case 'ProductSubtree':
      return {
        title: 'Product Account',
        action: 'Allow',
        cancelAction: 'Deny',
      };
    case 'ResourceAllocation':
      return { title: 'Resource Allocation', action: 'Allow' };
  }
}

function handlePreimageSubmitReview(
  label: string,
  review: PreimageSubmitReview,
  signal: AbortSignal,
  prompts: ConfirmationPrompts,
): Promise<boolean> {
  return prompts.confirmPreimage(label, Number(review.size), signal);
}

async function handleConfirmationReview(
  label: string,
  review: ModalReview,
  signal: AbortSignal,
  allowOnce: boolean,
  prompts: ConfirmationPrompts,
  handoff: ReviewHandoff | undefined,
): Promise<ConfirmationDecision> {
  const decision = await showConfirmationModal(
    label,
    confirmationCopy(review),
    review,
    signal,
    allowOnce,
    prompts,
    handoff,
  );
  if (decision === 'dismissed' && review.tag === 'IdentityDisclosure') {
    throw new Error(ERRORS.IDENTITY_DISCLOSURE_DISMISSED);
  }
  return decision;
}

// Temporary: the core does not report phone requests to the host, so this infers them from relayed frames. Remove once https://github.com/paritytech/trinity-user-agents/issues/1552 lands.
/**
 * Swaps an accepted review for the waiting step while its request is on the way to the phone. The step holds the
 * prompt slot until the user sends it to the background or the request ends, and its end shows a toast.
 */
function phoneWaitHandoff(
  label: string,
  review: ModalReview,
  phone: { requests: PhoneRequestTracker; notify: HostPrompts['notify'] },
  signal: AbortSignal,
  hold: HoldSlot,
): ReviewHandoff {
  return decision => {
    if (decision !== 'accepted' && decision !== 'accepted-once') {
      return undefined;
    }
    const match = phoneReviewMatch(review);
    const claim = match === undefined ? undefined : phone.requests.claim(match.matches);
    if (match === undefined || claim === undefined) {
      return undefined;
    }
    const { title, icon } = confirmationCopy(review);
    const answered = new AbortController();
    let background = false;
    void claim.ended.then(outcome => {
      answered.abort();
      m.count(S.PHONE_REQUEST, {
        outcome: phoneMetricOutcome(outcome),
        reason: claim.request.method,
        background: background ? 'yes' : 'no',
      });
      try {
        const notice = phoneOutcomeNotice({ outcome, title, app: withActiveTld(label) });
        if (notice !== undefined) {
          phone.notify(notice);
        }
      } catch (error) {
        captureException(error, {
          flow: 'wallet',
          step: 'phone_request_notice',
          tags: { method: claim.request.method },
        });
        log.error(`[dot.li phone request] ${claim.request.method} toast failed:`, error);
      }
    });
    const view = phoneWaitingView({ title, ...(icon === undefined ? {} : { icon }), ask: match.ask });
    let release = (): void => undefined;
    hold(
      new Promise<void>(resolve => {
        release = resolve;
      }),
    );
    return {
      view,
      signal: AbortSignal.any([signal, answered.signal]),
      closed: result => {
        background = result === WAITING_BACKGROUND;
        release();
      },
    };
  };
}

/**
 * Runs `task` in the prompt slot and answers with its result as soon as it settles. A step the task holds keeps the
 * slot until it closes, so no other prompt covers it.
 */
function answerFirst<T>(
  modalScope: BlockingModalScope,
  task: (signal: AbortSignal, hold: HoldSlot) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    modalScope
      .enqueue(async signal => {
        let held = Promise.resolve();
        resolve(
          await task(signal, closed => {
            held = closed;
          }),
        );
        await held;
      })
      // Once answered, only the scope's abort is left to reject, and that also closes the held step.
      .catch(reject);
  });
}

function permissionDecision(decision: ConfirmationDecision): PermissionDecision {
  switch (decision) {
    case 'accepted-once':
      return 'AllowOnce';
    case 'accepted':
      return 'AllowAlways';
    case 'rejected':
      return 'Deny';
    case 'dismissed':
      // The core keeps every answer but AllowOnce, so a dismissal rejects and the next request asks again.
      throw new Error(ERRORS.PERMISSION_DIALOG_DISMISSED);
  }
}

export function createUserConfirmationAdapters(
  label: string,
  prompts: ConfirmationPrompts,
  modalScope: BlockingModalScope,
  phoneRequests?: PhoneRequestTracker,
): Required<UserConfirmationHost> {
  const confirm = (
    review: ModalReview,
    signal: AbortSignal,
    allowOnce: boolean,
    hold: HoldSlot,
  ): Promise<ConfirmationDecision> =>
    handleConfirmationReview(
      label,
      review,
      signal,
      allowOnce,
      prompts,
      phoneRequests === undefined
        ? undefined
        : phoneWaitHandoff(label, review, { requests: phoneRequests, notify: prompts.notify }, signal, hold),
    );
  return {
    // Per-action reviews confirm a single operation, so there is no lifetime
    // to choose and the modal keeps two buttons.
    confirmUserAction: review =>
      answerFirst(modalScope, async (signal, hold) =>
        review.tag === 'PreimageSubmit'
          ? handlePreimageSubmitReview(label, review.value, signal, prompts)
          : (await confirm(review, signal, false, hold)) === 'accepted',
      ),
    // The core stores AllowAlways and Deny, and honours AllowOnce for this request only.
    confirmPermission: review =>
      answerFirst(modalScope, async (signal, hold) => {
        if (review.tag !== 'PreimageSubmit') {
          return permissionDecision(await confirm(review, signal, true, hold));
        }
        // The dialog's Allow lasts one request, so its Cancel does too, where a Deny would be stored for good.
        if (!(await handlePreimageSubmitReview(label, review.value, signal, prompts))) {
          throw new Error(ERRORS.PREIMAGE_SUBMIT_CANCELLED);
        }
        return 'AllowOnce';
      }),
  };
}
