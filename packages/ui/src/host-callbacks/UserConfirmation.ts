import type {
  AccountAccessReview,
  AccountAliasReview,
  ChatAuthorityReview,
  CreateProofReview,
  CreateTransactionReview,
  IdentityDisclosureReview,
  MainPurseChatPaymentReview,
  PermissionDecision,
  ProductSubtreeReview,
  ProfileDisclosureReview,
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
import { hexToBytes } from '@parity/truapi/scale';
import { getActiveServicesConfig } from '@dotli/config';
import { showPreimageSubmitModal } from '../preimage-modal.js';
import { ERRORS } from '../errors.js';
import { createBlockingModalScope, type BlockingModalScope } from '../blocking-modal-queue.js';
import { presentModal } from '../overlays/load.js';
import type { ModalButton, ModalField } from '../state/modals.js';

interface ConfirmationCopy {
  title: string;
  action: string;
  cancelAction?: string;
}

type ConfirmationField = ModalField;

type ConfirmationDecision = 'accepted' | 'accepted-once' | 'rejected' | 'dismissed';

/** Calling uses operation-scoped Media consent; PreimageSubmit has its own UI. */
type ModalReview = Exclude<UserConfirmationReview, { tag: 'PreimageSubmit' | 'Calling' }>;

/**
 * With `allowOnce`, "Allow once" is offered and highlighted, and the lasting
 * grant is labelled "Always allow".
 */
async function showConfirmationModal(
  label: string,
  copy: ConfirmationCopy,
  review: ModalReview,
  signal: AbortSignal,
  allowOnce: boolean,
): Promise<ConfirmationDecision> {
  const buttons: ModalButton<ConfirmationDecision>[] = [
    {
      label: copy.cancelAction ?? 'Cancel',
      variant: 'cancel',
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
  const { result } = await presentModal<ConfirmationDecision>(
    {
      title: copy.title,
      fields: confirmationDisplay(label, review).fields,
      buttons,
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    },
    signal,
  );
  return result;
}

function formatBytes(value: Uint8Array): string {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`;
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
    case 'ChatAuthority':
      return { fields: createChatAuthorityFields(review.value) };
    case 'MainPurseChatPayment':
      return { fields: createMainPurseChatPaymentFields(review.value) };
    case 'ProfileDisclosure':
      return { fields: createProfileDisclosureFields(review.value) };
    case 'ResourceAllocation':
      return { fields: createResourceAllocationFields(review.value) };
  }
}

function truncateHex(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function formatRawPayload(payload: RawPayload, watermarked: boolean): string {
  const value = payload.tag === 'Bytes' ? payload.value.bytes : payload.value.payload;
  const raw =
    payload.tag === 'Bytes' || (value.startsWith('0x') && value.length % 2 === 0)
      ? hexToBytes(value)
      : new TextEncoder().encode(value);
  const hex = formatBytes(raw);
  const prefix = '3c42797465733e';
  const suffix = '3c2f42797465733e';
  return watermarked && !(hex.startsWith(`0x${prefix}`) && hex.endsWith(suffix))
    ? `0x${prefix}${hex.slice(2)}${suffix}`
    : hex;
}

function formatDerivationIndex(index: DerivationIndex): string {
  return index.tag === 'Index' ? String(index.value) : index.value;
}

function formatProductAccount(account: ProductAccountId): string {
  return `${account.dotNsIdentifier} / ${formatDerivationIndex(account.derivationIndex)}`;
}

/**
 * Name the calling product when it signs with another product's account.
 *
 * A manifest `context` grant lets one product sign with an account derived for
 * another. The core always asks the user about such a request, and the prompt
 * has to say who is asking, not only whose account it is.
 */
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
      value: formatRawPayload(review.value.request.payload, review.value.watermarked),
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
  return [...createRingContextFields(review), { label: 'Message', value: formatBytes(review.message), mono: true }];
}

function createStatementSignFields(label: string, review: StatementStoreProductSignReview): ConfirmationField[] {
  return withCallingProduct(
    [
      { label: 'App', value: label },
      { label: 'Signer', value: formatProductAccount(review.account) },
      {
        label: 'Statement',
        value: truncateHex(formatBytes(review.payload.subarray(0, 41))),
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

function createChatAuthorityFields(review: ChatAuthorityReview): ConfirmationField[] {
  return [
    { label: 'Requesting product', value: review.productId },
    {
      label: 'Permission',
      value: 'Bind its device account to your wallet Chat identity and encrypt or decrypt Chat routing data',
    },
  ];
}

function createProfileDisclosureFields(review: ProfileDisclosureReview): ConfirmationField[] {
  return [
    { label: 'Requesting product', value: review.productId },
    {
      label: 'Permission',
      value:
        "Share this app's profile with app audiences or selected contacts. Personally shared profiles may be shown across the recipients' apps.",
    },
    {
      label: 'Audience changes',
      value:
        'This authorizes the app to choose and update recipients. Always allow remembers that permission; it does not ask again for each audience change.',
    },
  ];
}

function createMainPurseChatPaymentFields(review: MainPurseChatPaymentReview): ConfirmationField[] {
  const services = getActiveServicesConfig();
  if (
    services.coinage === undefined ||
    review.coinageInstanceId !== services.coinage.instanceId ||
    formatBytes(review.genesisHash) !== services.people.genesis.toLowerCase()
  ) {
    throw new Error('Main-purse payment does not match the configured chain and asset');
  }
  // Keep u64 amounts exact through the review; Number loses cents above 2^53.
  const symbol = services.coinage.symbol;
  const amount = (cents: bigint): string =>
    `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')} ${symbol}`;
  return [
    { label: 'Requesting product', value: review.callingProductId },
    {
      label: 'Recipient',
      value: review.recipientUsername ?? 'Unnamed identity',
    },
    {
      label: 'Recipient identity',
      value: formatBytes(review.recipientIdentity),
      mono: true,
    },
    { label: 'Recipient amount', value: amount(review.amountCents) },
    {
      label: 'Maximum purse debit (including fees)',
      value: amount(review.maxDebitCents),
    },
    {
      label: 'Chain genesis',
      value: formatBytes(review.genesisHash),
      mono: true,
    },
    {
      label: 'Coinage asset instance',
      value: String(review.coinageInstanceId),
    },
    {
      label: 'Payment operation',
      value: formatBytes(review.operationId),
      mono: true,
    },
    {
      label: 'One-time payment',
      value:
        'Spend from your main purse for this payment only. Chat access and automatic signing never approve payments.',
      warning: true,
    },
  ];
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
      return { title: 'Sign Transaction', action: 'Sign' };
    case 'SignRaw':
      return review.value.value.watermarked
        ? { title: 'Sign Message', action: 'Sign' }
        : { title: 'Sign Unwatermarked Payload', action: 'Sign Unwatermarked' };
    case 'StatementStoreProductSign':
      return { title: 'Sign Statement', action: 'Sign' };
    case 'SignVrf':
      return { title: 'Sign VRF Transcript', action: 'Sign' };
    case 'CreateTransaction':
      return { title: 'Sign Transaction', action: 'Sign' };
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
    case 'ChatAuthority':
      return {
        title: 'Chat Identity Authority',
        action: 'Allow',
        cancelAction: 'Deny',
      };
    case 'MainPurseChatPayment':
      return {
        title: 'Send Main-Purse Payment',
        action: 'Send payment',
        cancelAction: 'Reject',
      };
    case 'ProductSubtree':
      return {
        title: 'Product Account',
        action: 'Allow',
        cancelAction: 'Deny',
      };
    case 'ResourceAllocation':
      return { title: 'Resource Allocation', action: 'Allow' };
    case 'ProfileDisclosure':
      return {
        title: 'Allow Profile Sharing',
        action: 'Allow',
        cancelAction: 'Deny',
      };
  }
}

async function handleConfirmationReview(
  label: string,
  review: ModalReview,
  signal: AbortSignal,
  allowOnce: boolean,
): Promise<ConfirmationDecision> {
  const decision = await showConfirmationModal(label, confirmationCopy(review), review, signal, allowOnce);
  if (decision === 'dismissed' && review.tag === 'IdentityDisclosure') {
    throw new Error(ERRORS.IDENTITY_DISCLOSURE_DISMISSED);
  }
  // A failed prompt leaves the grant undetermined in the core, so dismissing
  // the dialog asks again next time instead of storing a refusal.
  if (decision === 'dismissed' && review.tag === 'ProfileDisclosure') {
    throw new Error(ERRORS.PERMISSION_DIALOG_DISMISSED);
  }
  return decision;
}

function permissionDecision(decision: ConfirmationDecision): PermissionDecision {
  switch (decision) {
    case 'accepted-once':
      return 'AllowOnce';
    case 'accepted':
      return 'AllowAlways';
    case 'rejected':
    case 'dismissed':
      return 'Deny';
  }
}

export function createUserConfirmationAdapters(
  label: string,
  modalScope: BlockingModalScope = createBlockingModalScope(),
): Required<UserConfirmationHost> {
  return {
    // Per-action reviews confirm a single operation, so there is no lifetime
    // to choose and the modal keeps two buttons.
    confirmUserAction: review => {
      if (review.tag === 'Calling') {
        return Promise.reject(new Error('Calling requires operation-scoped Media consent'));
      }
      return modalScope.enqueue(async signal =>
        review.tag === 'PreimageSubmit'
          ? (await showPreimageSubmitModal(review.value, signal, false)) === 'AllowOnce'
          : (await handleConfirmationReview(label, review, signal, false)) === 'accepted',
      );
    },
    // Only the explicit lifetime decision may grant future operations.
    confirmPermission: review => {
      if (review.tag === 'Calling') {
        return Promise.reject(new Error('Calling requires operation-scoped Media consent'));
      }
      return modalScope.enqueue(async signal =>
        review.tag === 'PreimageSubmit'
          ? showPreimageSubmitModal(review.value, signal)
          : permissionDecision(await handleConfirmationReview(label, review, signal, true)),
      );
    },
  };
}
