// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  AccountAccessReview,
  AccountAliasReview,
  CreateProofReview,
  CreateTransactionReview,
  IdentityDisclosureReview,
  ProductSubtreeReview,
  ResourceAllocationReview,
  SignPayloadReview,
  SignRawReview,
  SignVrfReview,
  StatementStoreProductSignReview,
  UserConfirmation as UserConfirmationHost,
} from '@parity/truapi-host';
import type {
  AllocatableResource,
  DerivationIndex,
  HostSignPayloadData,
  LegacyAccountTxPayload,
  ProductAccountId,
  ProductAccountTxPayload,
  ProductId,
  RawPayload,
  RingLocationJunction,
} from '@parity/truapi';
import { withActiveTld } from '@dotli/config';
import { createDeferred, toHex } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import type { BlockingModalScope, HoldSlot } from '../createBlockingModalCoordinator.js';
import type { ModalField, ModalHandoff, ModalView } from '@dotli/ui';
import { SignIcon } from '../../components/icons/SignIcon.js';
import { getGrantButtons } from '../../components/permissions/permissionDialog.js';
import { phoneWaitingView, WAITING_BACKGROUND } from '../../components/signing/phoneWaitingView.js';
import { isDismissed, isGranted, toPermissionDecision, type GrantAnswer, type HostPrompts } from '../hostPrompts.js';
import { PHONE_METHODS } from '../phoneMethods.js';
import { reportPhoneEnd } from '../phoneReport.js';
import type { PhoneRequestTracker } from '../createPhoneRequestTracker.js';
import { matchPhoneReview } from '../matchPhoneReview.js';
import { servedRequests, type ServedReview } from './servedRequests.js';

/** The prompts a confirmation asks through and tells its outcome on. */
type ConfirmationPrompts = Pick<HostPrompts, 'confirmReview' | 'notify'>;

type ConfirmationCopy = {
  title: string;
  action: string;
  cancelAction?: string;
  icon?: ModalView<string>['icon'];
};

type ConfirmationField = ModalField;

/** The step an answered review hands its place to, if any. */
type ReviewHandoff = (answer: GrantAnswer) => ModalHandoff | undefined;

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
  review: ServedReview;
  signal: AbortSignal;
  /** Whether the review offers "Allow once" beside "Always allow". */
  allowOnce: boolean;
  hold: HoldSlot;
};

type HandleConfirmationReviewParams = {
  label: string;
  review: ServedReview;
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
  callingProductId: ProductId | undefined;
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

type CreatePhoneWaitHandoffParams = {
  label: string;
  review: ServedReview;
  requests: PhoneRequestTracker;
  notify: HostPrompts['notify'];
  signal: AbortSignal;
  hold: HoldSlot;
};

/**
 * Answers the core's per-action reviews and permission reviews by showing them in the page's prompt queue. A dismissed
 * permission review and a dismissed identity disclosure reject with their error texts. A review of a request this
 * host does not serve is refused without a modal.
 */
export function createUserConfirmationAdapters({
  label,
  prompts,
  modalScope,
  phoneRequests,
}: Params): Required<UserConfirmationHost> {
  function confirm({ review, signal, allowOnce, hold }: ConfirmParams): Promise<GrantAnswer> {
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
      !servedRequests.isServed(review)
        ? Promise.resolve(false)
        : modalScope.enqueue(async (signal, hold) =>
            isGranted(await confirm({ review, signal, allowOnce: false, hold })),
          ),
    // The core stores AllowAlways and Deny and decides how long AllowOnce lasts. A drain review is refused by a
    // rejection, since a Deny would be stored.
    confirmPermission: review =>
      !servedRequests.isServed(review)
        ? Promise.reject(new Error(ERRORS.UNSERVED_REQUEST))
        : modalScope.enqueue(async (signal, hold) =>
            toPermissionDecision(await confirm({ review, signal, allowOnce: true, hold })),
          ),
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
}: ShowConfirmationModalParams): Promise<GrantAnswer> {
  return prompts.confirmReview<GrantAnswer>({
    dialog: {
      ...(copy.icon === undefined ? {} : { icon: copy.icon }),
      title: copy.title,
      fields: getConfirmationFields(label, review),
      buttons: getGrantButtons({ allowOnce, allowLabel: copy.action, denyLabel: copy.cancelAction ?? 'Cancel' }),
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
    },
    signal,
    handoff,
  });
}

function getConfirmationFields(label: string, review: ServedReview): ConfirmationField[] {
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

function getConfirmationCopy(review: ServedReview): ConfirmationCopy {
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

async function handleConfirmationReview(params: HandleConfirmationReviewParams): Promise<GrantAnswer> {
  const { review } = params;
  const answer = await showConfirmationModal({ ...params, copy: getConfirmationCopy(review) });
  if (isDismissed(answer) && review.tag === 'IdentityDisclosure') {
    throw new Error(ERRORS.IDENTITY_DISCLOSURE_DISMISSED);
  }
  return answer;
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
  function handOff(answer: GrantAnswer): ModalHandoff | undefined {
    if (!isGranted(answer)) {
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
