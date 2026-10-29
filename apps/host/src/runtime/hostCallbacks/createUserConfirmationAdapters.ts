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
  LegacyAccountTxPayload,
  ProductAccountId,
  ProductAccountTxPayload,
  RawPayload,
  RingLocationJunction,
} from '@parity/truapi';
import { withActiveTld } from '@dotli/config';
import { createDeferred, toHex } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import type { BlockingModalScope, HoldSlot } from '../createBlockingModalCoordinator.js';
import type { ModalButton, ModalField, ModalHandoff, ModalView } from '@dotli/ui';
import { SignIcon } from '../../components/icons/SignIcon.js';
import { phoneWaitingView, WAITING_BACKGROUND } from '../../components/signing/phoneWaitingView.js';
import type { HostPrompts } from '../hostPrompts.js';
import { PHONE_METHODS } from '../phoneMethods.js';
import { reportPhoneEnd } from '../phoneReport.js';
import type { PhoneRequestTracker } from '../createPhoneRequestTracker.js';
import { matchPhoneReview } from '../matchPhoneReview.js';

/** The prompts a confirmation asks through and tells its outcome on. */
type ConfirmationPrompts = Pick<HostPrompts, 'confirmPreimage' | 'confirmReview' | 'notify'>;

type ConfirmationCopy = {
  title: string;
  action: string;
  cancelAction?: string;
  icon?: ModalView<string>['icon'];
};

type ConfirmationField = ModalField;

type ConfirmationDecision = 'accepted' | 'accepted-once' | 'rejected' | 'dismissed';

/** The step an answered review hands its place to, if any. */
type ReviewHandoff = (decision: ConfirmationDecision) => ModalHandoff | undefined;

/** PreimageSubmit gets its own modal. */
type ModalReview = Exclude<UserConfirmationReview, { tag: 'PreimageSubmit' }>;

type Params = {
  /** The product the confirmations speak for. */
  label: string;
  /** The page's prompts the reviews are shown through. */
  prompts: ConfirmationPrompts;
  /** Where the confirmations queue, on the page's one coordinator. */
  modalScope: BlockingModalScope;
  /** What an accepted review claims the phone's request from. */
  phoneRequests: PhoneRequestTracker;
};

type ConfirmParams = {
  review: ModalReview;
  signal: AbortSignal;
  /** Whether the review offers "Allow once" beside "Always allow". */
  allowOnce: boolean;
  hold: HoldSlot;
};

type HandleConfirmationReviewParams = {
  label: string;
  review: ModalReview;
  signal: AbortSignal;
  allowOnce: boolean;
  prompts: ConfirmationPrompts;
  handoff: ReviewHandoff;
};

type ShowConfirmationModalParams = HandleConfirmationReviewParams & {
  copy: ConfirmationCopy;
};

type PrependCallingProductParams = {
  fields: ConfirmationField[];
  callingProductId: string | undefined;
  account: ProductAccountId;
};

type CreatePayloadFieldsParams = {
  app: string;
  signer: string;
  payload: HostSignPayloadData;
};

type CreateMessageFieldsParams = {
  app: string;
  signer: string;
  payload: RawPayload;
};

type CreateTransactionPayloadFieldsParams = {
  app: string;
  signer: string;
  payload: ProductAccountTxPayload | LegacyAccountTxPayload;
};

type HandlePreimageSubmitReviewParams = {
  label: string;
  review: PreimageSubmitReview;
  signal: AbortSignal;
  prompts: ConfirmationPrompts;
};

type CreatePhoneWaitHandoffParams = {
  label: string;
  review: ModalReview;
  requests: PhoneRequestTracker;
  notify: HostPrompts['notify'];
  signal: AbortSignal;
  hold: HoldSlot;
};

/**
 * Answers the core's per-action reviews and permission reviews by showing them in the page's prompt queue. A dismissed
 * permission review, a dismissed identity disclosure and a cancelled preimage submit permission reject with their
 * error texts.
 */
export function createUserConfirmationAdapters({
  label,
  prompts,
  modalScope,
  phoneRequests,
}: Params): Required<UserConfirmationHost> {
  function confirm({ review, signal, allowOnce, hold }: ConfirmParams): Promise<ConfirmationDecision> {
    return handleConfirmationReview({
      label,
      review,
      signal,
      allowOnce,
      prompts,
      handoff: createPhoneWaitHandoff({ label, review, requests: phoneRequests, notify: prompts.notify, signal, hold }),
    });
  }

  return {
    // Per-action reviews confirm a single operation, so there is no lifetime
    // to choose and the modal keeps two buttons.
    confirmUserAction: review =>
      modalScope.enqueue(async (signal, hold) =>
        review.tag === 'PreimageSubmit'
          ? handlePreimageSubmitReview({ label, review: review.value, signal, prompts })
          : (await confirm({ review, signal, allowOnce: false, hold })) === 'accepted',
      ),
    // The core stores AllowAlways and Deny, and honours AllowOnce for this request only.
    confirmPermission: review =>
      modalScope.enqueue(async (signal, hold) => {
        if (review.tag !== 'PreimageSubmit') {
          return getPermissionDecision(await confirm({ review, signal, allowOnce: true, hold }));
        }
        // The dialog's Allow lasts one request, so its Cancel does too, where a Deny would be stored for good.
        if (!(await handlePreimageSubmitReview({ label, review: review.value, signal, prompts }))) {
          throw new Error(ERRORS.PREIMAGE_SUBMIT_CANCELLED);
        }
        return 'AllowOnce';
      }),
  };
}

function showConfirmationModal({
  label,
  copy,
  review,
  signal,
  allowOnce,
  prompts,
  handoff,
}: ShowConfirmationModalParams): Promise<ConfirmationDecision> {
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
      fields: getConfirmationFields(label, review),
      buttons,
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
    },
    signal,
    { handoff },
  );
}

function getConfirmationFields(label: string, review: ModalReview): ConfirmationField[] {
  switch (review.tag) {
    case 'SignPayload':
      return createSignPayloadFields(label, review.value);
    case 'SignRaw':
      return createSignRawFields(label, review.value);
    case 'StatementStoreProductSign':
      return createStatementSignFields(label, review.value);
    case 'SignVrf':
      return createSignVrfFields(review.value);
    case 'CreateTransaction':
      return createTransactionFields(label, review.value);
    case 'AccountAlias':
      return createRingContextFields(review.value);
    case 'CreateProof':
      return createProofFields(review.value);
    case 'AccountAccess':
      return createAccountAccessFields(review.value);
    case 'IdentityDisclosure':
    case 'ProductSubtree':
      return createRequestingProductFields(review.value);
    case 'ResourceAllocation':
      return createResourceAllocationFields(review.value);
  }
}

function truncateHex(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function formatRawPayload(payload: RawPayload): string {
  switch (payload.tag) {
    case 'Bytes':
      return truncateHex(payload.value.bytes);
    case 'Payload':
      return truncateHex(payload.value.payload);
  }
}

function formatDerivationIndex(index: DerivationIndex): string {
  switch (index.tag) {
    case 'Index':
      return String(index.value);
    case 'Raw':
      return index.value;
  }
}

function formatProductAccount(account: ProductAccountId): string {
  return `${account.dotNsIdentifier} / ${formatDerivationIndex(account.derivationIndex)}`;
}

/** A manifest `context` grant lets one product sign with another's account, so the prompt must say who asks. */
function prependCallingProduct({
  fields,
  callingProductId,
  account,
}: PrependCallingProductParams): ConfirmationField[] {
  if (callingProductId === undefined || callingProductId === account.dotNsIdentifier) {
    return fields;
  }
  return [{ label: 'Requesting product', value: callingProductId }, ...fields];
}

function createPayloadFields({ app, signer, payload }: CreatePayloadFieldsParams): ConfirmationField[] {
  return [
    { label: 'App', value: app },
    { label: 'Signer', value: signer },
    { label: 'Genesis Hash', value: payload.genesisHash, mono: true },
    { label: 'Call Data', value: truncateHex(payload.method), mono: true },
    { label: 'Version', value: String(payload.version) },
  ];
}

function createSignPayloadFields(label: string, review: SignPayloadReview): ConfirmationField[] {
  switch (review.tag) {
    case 'Product': {
      const { callingProductId, request } = review.value;
      return prependCallingProduct({
        fields: createPayloadFields({
          app: label,
          signer: formatProductAccount(request.account),
          payload: request.payload,
        }),
        callingProductId,
        account: request.account,
      });
    }
    case 'LegacyAccount':
      return createPayloadFields({ app: label, signer: review.value.signer, payload: review.value.payload });
  }
}

function createSignRawFields(label: string, review: SignRawReview): ConfirmationField[] {
  const fields = createSignRawSignerFields(label, review);
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

function createSignRawSignerFields(label: string, review: SignRawReview): ConfirmationField[] {
  switch (review.tag) {
    case 'Product': {
      const { callingProductId, request } = review.value;
      return prependCallingProduct({
        fields: createMessageFields({
          app: label,
          signer: formatProductAccount(request.account),
          payload: request.payload,
        }),
        callingProductId,
        account: request.account,
      });
    }
    case 'LegacyAccount': {
      const { request } = review.value;
      return createMessageFields({ app: label, signer: request.signer, payload: request.payload });
    }
  }
}

function createMessageFields({ app, signer, payload }: CreateMessageFieldsParams): ConfirmationField[] {
  return [
    { label: 'App', value: app },
    { label: 'Signer', value: signer },
    {
      label: 'Message',
      value: formatRawPayload(payload),
      mono: true,
    },
  ];
}

function createTransactionFields(label: string, review: CreateTransactionReview): ConfirmationField[] {
  switch (review.tag) {
    case 'Product': {
      const { callingProductId, payload } = review.value;
      return prependCallingProduct({
        fields: createTransactionPayloadFields({
          app: label,
          signer: formatProductAccount(payload.signer),
          payload,
        }),
        callingProductId,
        account: payload.signer,
      });
    }
    case 'LegacyAccount':
      return createTransactionPayloadFields({ app: label, signer: review.value.signer, payload: review.value });
  }
}

function createTransactionPayloadFields({
  app,
  signer,
  payload,
}: CreateTransactionPayloadFieldsParams): ConfirmationField[] {
  return [
    { label: 'App', value: app },
    { label: 'Signer', value: signer },
    { label: 'Genesis Hash', value: payload.genesisHash, mono: true },
    { label: 'Call Data', value: truncateHex(payload.callData), mono: true },
    { label: 'Tx Ext Version', value: String(payload.txExtVersion) },
  ];
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
  return prependCallingProduct({
    fields: [
      { label: 'App', value: label },
      { label: 'Signer', value: formatProductAccount(review.account) },
      {
        label: 'Statement',
        value: truncateHex(toHex(review.payload.subarray(0, 41))),
        mono: true,
      },
    ],
    callingProductId: review.callingProductId,
    account: review.account,
  });
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
  switch (resource.tag) {
    case 'SmartContractAllowance':
      return `SmartContractAllowance / ${formatDerivationIndex(resource.value)}`;
    case 'StatementStoreAllowance':
    case 'BulletinAllowance':
    case 'AutoSigning':
      return resource.tag;
  }
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

function getConfirmationCopy(review: ModalReview): ConfirmationCopy {
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

function handlePreimageSubmitReview({
  label,
  review,
  signal,
  prompts,
}: HandlePreimageSubmitReviewParams): Promise<boolean> {
  return prompts.confirmPreimage({ label, size: Number(review.size), signal });
}

async function handleConfirmationReview(params: HandleConfirmationReviewParams): Promise<ConfirmationDecision> {
  const { review } = params;
  const decision = await showConfirmationModal({ ...params, copy: getConfirmationCopy(review) });
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
function createPhoneWaitHandoff({
  label,
  review,
  requests,
  notify,
  signal,
  hold,
}: CreatePhoneWaitHandoffParams): ReviewHandoff {
  function handOff(decision: ConfirmationDecision): ModalHandoff | undefined {
    if (decision !== 'accepted' && decision !== 'accepted-once') {
      return undefined;
    }
    const matches = matchPhoneReview(review);
    const claim = matches === undefined ? undefined : requests.claim(matches);
    if (claim === undefined) {
      return undefined;
    }
    const { method } = claim.request;
    const { title, icon } = getConfirmationCopy(review);
    const answered = new AbortController();
    let background = false;
    void claim.ended.then(outcome => {
      answered.abort();
      reportPhoneEnd({ method, outcome, background, title, app: withActiveTld(label) }, notify);
    });
    const closed = createDeferred<undefined>();
    hold(closed.promise);
    return {
      view: phoneWaitingView({ title, ...(icon === undefined ? {} : { icon }), ask: PHONE_METHODS[method].ask }),
      signal: AbortSignal.any([signal, answered.signal]),
      closed(result) {
        background = result === WAITING_BACKGROUND;
        closed.resolve(undefined);
      },
    };
  }

  return handOff;
}

function getPermissionDecision(decision: ConfirmationDecision): PermissionDecision {
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
