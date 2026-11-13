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
import { toHex } from '@dotli/shared';
import type { ModalField } from '@dotli/ui';
import type { ServedReview } from './servedRequests.js';

/** The fields a confirmation dialog shows for `review`, which the product `label` asks for. Never throws. */
export function getConfirmationFields(label: string, review: ServedReview): ModalField[] {
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
}: {
  fields: ModalField[];
  callingProductId: ProductId | undefined;
  account: ProductAccountId;
}): ModalField[] {
  if (callingProductId === undefined || callingProductId === account.dotNsIdentifier) {
    return fields;
  }
  return [{ label: 'Requesting product', value: callingProductId }, ...fields];
}

function createPayloadFields({
  app,
  signer,
  payload,
}: {
  app: string;
  signer: string;
  payload: HostSignPayloadData;
}): ModalField[] {
  return [
    { label: 'App', value: app },
    { label: 'Signer', value: signer },
    { label: 'Genesis Hash', value: payload.genesisHash, mono: true },
    { label: 'Call Data', value: truncateHex(payload.method), mono: true },
    { label: 'Version', value: String(payload.version) },
  ];
}

function createSignPayloadFields(label: string, review: SignPayloadReview): ModalField[] {
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

function createSignRawFields(label: string, review: SignRawReview): ModalField[] {
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

function createSignRawSignerFields(label: string, review: SignRawReview): ModalField[] {
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

function createMessageFields({
  app,
  signer,
  payload,
}: {
  app: string;
  signer: string;
  payload: RawPayload;
}): ModalField[] {
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

function createTransactionFields(label: string, review: CreateTransactionReview): ModalField[] {
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
}: {
  app: string;
  signer: string;
  payload: ProductAccountTxPayload | LegacyAccountTxPayload;
}): ModalField[] {
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

function createRingContextFields(review: AccountAliasReview | CreateProofReview): ModalField[] {
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

function createProofFields(review: CreateProofReview): ModalField[] {
  return [...createRingContextFields(review), { label: 'Message', value: toHex(review.message), mono: true }];
}

function createStatementSignFields(label: string, review: StatementStoreProductSignReview): ModalField[] {
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

function createSignVrfFields(review: SignVrfReview): ModalField[] {
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

function createAccountAccessFields(review: AccountAccessReview): ModalField[] {
  return [
    { label: 'Requesting product', value: review.requestingProductId },
    { label: 'Requested account', value: review.targetProductId },
  ];
}

function createRequestingProductFields(review: IdentityDisclosureReview | ProductSubtreeReview): ModalField[] {
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

function createResourceAllocationFields(review: ResourceAllocationReview): ModalField[] {
  return [
    { label: 'Requesting product', value: review.callingProductId },
    {
      label: 'Resources',
      value: review.resources.map(formatResource).join(', '),
    },
  ];
}
