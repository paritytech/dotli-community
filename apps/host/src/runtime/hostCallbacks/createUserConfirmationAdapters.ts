// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { UserConfirmation as UserConfirmationHost } from '@parity/truapi-host';
import { withActiveTld } from '@dotli/config';
import { createDeferred } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import type { HoldSlot } from '../createBlockingModalCoordinator.js';
import type { ModalHandoff, ModalView } from '@dotli/ui';
import { SignIcon } from '../../components/icons/SignIcon.js';
import { getGrantButtons } from '../../components/permissions/permissionDialog.js';
import { phoneWaitingView, WAITING_BACKGROUND } from '../../components/signing/phoneWaitingView.js';
import { isDismissed, isGranted, toPermissionDecision, type GrantAnswer, type HostPrompts } from '../hostPrompts.js';
import { PHONE_METHODS } from '../phoneMethods.js';
import { reportPhoneEnd } from '../phoneReport.js';
import type { CoreContext } from '../createPageCore.js';
import { matchPhoneReview } from '../matchPhoneReview.js';
import { getConfirmationFields } from './getConfirmationFields.js';
import { servedRequests, type ServedReview } from './servedRequests.js';

type Params = {
  /** The core the confirmations speak for, whose queue they wait in and whose phone requests they claim. */
  core: Pick<CoreContext, 'product' | 'blockingModalScope' | 'phoneRequests'>;
  /** The page's prompts the reviews are shown through. */
  prompts: Pick<HostPrompts, 'confirmReview' | 'notify'>;
};

type ConfirmParams = {
  review: ServedReview;
  signal: AbortSignal;
  /** Whether the review offers "Allow once" beside "Always allow". */
  allowOnce: boolean;
  hold: HoldSlot;
};

const CONFIRMATION_COPY: Record<
  ServedReview['tag'],
  { title: string; action: string; cancelAction: string; icon?: ModalView<string>['icon'] }
> = {
  SignPayload: { title: 'Sign Transaction', action: 'Sign', cancelAction: 'Cancel', icon: SignIcon },
  SignRaw: { title: 'Sign Message', action: 'Sign', cancelAction: 'Cancel', icon: SignIcon },
  StatementStoreProductSign: { title: 'Sign Statement', action: 'Sign', cancelAction: 'Cancel', icon: SignIcon },
  SignVrf: { title: 'Sign VRF Transcript', action: 'Sign', cancelAction: 'Cancel', icon: SignIcon },
  CreateTransaction: { title: 'Sign Transaction', action: 'Sign', cancelAction: 'Cancel', icon: SignIcon },
  AccountAlias: { title: 'Alias Permission', action: 'Allow', cancelAction: 'Deny' },
  CreateProof: { title: 'Proof Permission', action: 'Allow', cancelAction: 'Deny' },
  AccountAccess: { title: 'Account Access', action: 'Allow', cancelAction: 'Deny' },
  IdentityDisclosure: { title: 'Identity Disclosure', action: 'Allow', cancelAction: 'Deny' },
  ProductSubtree: { title: 'Product Account', action: 'Allow', cancelAction: 'Deny' },
  ResourceAllocation: { title: 'Resource Allocation', action: 'Allow', cancelAction: 'Cancel' },
};

/**
 * Answers the core's per-action reviews and permission reviews by showing them in the page's prompt queue. A dismissed
 * permission review and a dismissed identity disclosure reject with their error texts. A review of a request this
 * host does not serve is refused without a modal.
 */
export function createUserConfirmationAdapters({ core, prompts }: Params): Required<UserConfirmationHost> {
  const { label } = core.product;

  async function confirm({ review, signal, allowOnce, hold }: ConfirmParams): Promise<GrantAnswer> {
    const copy = CONFIRMATION_COPY[review.tag];
    const answer = await prompts.confirmReview<GrantAnswer>({
      dialog: {
        ...(copy.icon === undefined ? {} : { icon: copy.icon }),
        title: copy.title,
        fields: getConfirmationFields(label, review),
        buttons: getGrantButtons({ allowOnce, allowLabel: copy.action, denyLabel: copy.cancelAction }),
        dismissOnBackdrop: true,
        dismissResult: 'dismissed',
      },
      signal,
      handoff: createPhoneWaitHandoff({ review, signal, hold }),
    });
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
  function createPhoneWaitHandoff({ review, signal, hold }: Pick<ConfirmParams, 'review' | 'signal' | 'hold'>) {
    function handOff(answer: GrantAnswer): ModalHandoff | undefined {
      if (!isGranted(answer)) {
        return undefined;
      }
      const matches = matchPhoneReview(review);
      const claim = matches === undefined ? undefined : core.phoneRequests.claim(matches);
      if (claim === undefined) {
        return undefined;
      }
      const { method } = claim.request;
      const { title, icon } = CONFIRMATION_COPY[review.tag];
      const answered = new AbortController();
      let background = false;
      void claim.ended.then(outcome => {
        answered.abort();
        reportPhoneEnd({ method, outcome, background, title, app: withActiveTld(label) }, prompts.notify);
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

  return {
    // Per-action reviews confirm a single operation, so there is no lifetime
    // to choose and the modal keeps two buttons.
    confirmUserAction: review =>
      !servedRequests.isServed(review)
        ? Promise.resolve(false)
        : core.blockingModalScope.enqueue(async (signal, hold) =>
            isGranted(await confirm({ review, signal, allowOnce: false, hold })),
          ),
    // The core stores AllowAlways and Deny and decides how long AllowOnce lasts. A drain review is refused by a
    // rejection, since a Deny would be stored.
    confirmPermission: review =>
      !servedRequests.isServed(review)
        ? Promise.reject(new Error(ERRORS.UNSERVED_REQUEST))
        : core.blockingModalScope.enqueue(async (signal, hold) =>
            toPermissionDecision(await confirm({ review, signal, allowOnce: true, hold })),
          ),
  };
}
