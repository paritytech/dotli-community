// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { log } from '@dotli/shared';
import { rasterImageType, type ProfileDrawerOptions } from '../../profile/drawer.js';
import { moodIsCurrent, type Mood } from '../../profile/profile-record.js';
import { INTENSITY, MOOD_PALETTE } from '../../profile/mood-ring.js';
import { Modal } from '../floating/Modal.js';
import { Button } from '../primitives/Button.js';
import { Spinner } from '../primitives/Spinner.js';
import { MoodRing } from './MoodRing.js';
import s from './ProfileDrawer.module.css';

const TITLE_ID = 'profile-drawer-title';

/**
 * A profile a product asked the host to show (profile/drawer.ts mounts it):
 * the photo and mood the host fetched and decrypted, attributed to the
 * product and, when shared over Chat, to the contact. Close, Escape, the
 * scrim and a swipe all close it.
 */
export function ProfileDrawer(props: {
  options: ProfileDrawerOptions;
  signal: AbortSignal;
  onClose: () => void;
}): JSX.Element {
  const initiallyLoading = untrack(() => props.options.loadProfile !== undefined);
  const [loading, setLoading] = createSignal(initiallyLoading);
  const [photo, setPhoto] = createSignal<string | null>(null);
  const [mood, setMood] = createSignal<Mood | undefined>(undefined);
  const [contactName, setContactName] = createSignal(untrack(() => props.options.contactName));
  const emptyMessage = 'No information shared with you yet.';
  const [status, setStatus] = createSignal(initiallyLoading ? 'Loading profile…' : emptyMessage);
  const [failed, setFailed] = createSignal(false);
  let objectUrl: string | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    if (objectUrl !== undefined) {
      URL.revokeObjectURL(objectUrl);
    }
    props.onClose();
  });
  const fail = (message: string): void => {
    setFailed(true);
    setStatus(message);
  };
  // A root is created per presentation; start its loader after mount and
  // retain that presentation's signal through every asynchronous continuation.
  onSettled(() => {
    const { options, signal } = untrack(() => ({ options: props.options, signal: props.signal }));
    if (signal.aborted) {
      return;
    }
    if (options.loadContactName !== undefined) {
      void options.loadContactName(signal).then(
        name => {
          if (!disposed && !signal.aborted && name !== undefined) {
            setContactName(name);
          }
        },
        // A missing/unavailable name keeps the generic attribution, not a profile error.
        () => undefined,
      );
    }
    if (options.loadProfile === undefined) {
      return;
    }
    void options.loadProfile(signal).then(
      ({ avatar, mood: nextMood }) => {
        if (disposed || signal.aborted) {
          return;
        }
        setLoading(false);
        const activeMood = nextMood !== undefined && moodIsCurrent(nextMood) ? nextMood : undefined;
        setMood(activeMood);
        setStatus('');
        if (avatar === null) {
          if (activeMood === undefined) {
            setStatus(emptyMessage);
          }
          return;
        }
        const type = rasterImageType(avatar);
        if (type === null) {
          fail('The profile image is not a supported format.');
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([avatar as Uint8Array<ArrayBuffer>], { type }));
        setPhoto(objectUrl);
      },
      (error: unknown) => {
        if (disposed || signal.aborted) {
          return;
        }
        setLoading(false);
        // Never include bearer references or decrypted content in diagnostics.
        const name = error instanceof Error ? error.name : 'Error';
        log.warn('[profile] drawer load failed:', name);
        fail(
          name === 'TimeoutError'
            ? 'The profile could not be fetched. Try again later.'
            : name === 'OperationError'
              ? 'The profile could not be opened. The reference may be wrong or out of date.'
              : 'The profile is unavailable.',
        );
      },
    );
  });
  return (
    <Modal
      open
      onOpenChange={() => {
        props.onClose();
      }}
      title="Profile"
      labelledBy={TITLE_ID}
      initialFocus={() => closeButton}
      testId="profile-drawer"
    >
      <Modal.Head titleId={TITLE_ID} title="Profile" />
      <Modal.Body>
        <div class={s['profile']}>
          <Show when={contactName()}>
            {name => (
              <p class={s['contact']} data-testid="profile-drawer-contact">
                {name()}
              </p>
            )}
          </Show>
          <div class={s['portrait']}>
            <Show when={mood()}>{value => <MoodRing mood={value()} size={160} animated />}</Show>
            <div
              class={s['avatar']}
              data-empty={!loading() && photo() === null ? '' : undefined}
              data-testid="profile-drawer-avatar"
            >
              <Show when={loading()}>
                <Spinner testId="profile-drawer-spinner" />
              </Show>
              <Show when={photo()}>
                {url => (
                  <img
                    src={url()}
                    alt="Profile picture"
                    onError={() => {
                      setPhoto(null);
                      fail('The profile image could not be displayed.');
                    }}
                  />
                )}
              </Show>
            </div>
          </div>
          <p class={s['mood']} data-testid="profile-drawer-mood">
            <Show when={mood()}>
              {value => (
                <>{`${MOOD_PALETTE[value().kind].label} · ${INTENSITY[value().intensity].label.toLowerCase()} · ${String(Math.max(1, Math.round((value().setAt + value().ttlSecs - Date.now() / 1000) / 3600)))} h left`}</>
              )}
            </Show>
          </p>
          <p
            class={s['status']}
            data-error={failed() ? '' : undefined}
            data-testid="profile-drawer-status"
            role="status"
          >
            {status()}
          </p>
          <p class={s['attribution']} data-testid="profile-drawer-attribution">
            {props.options.loadProfile === undefined ? (
              `Shown in ${props.options.productId}. Shared information will appear here after it reaches this host.`
            ) : contactName() === undefined ? (
              `Shown by ${props.options.productId}. Seity profile content is self-described; dot.li does not verify it.`
            ) : (
              <>
                Shared with you over Chat by {contactName()} · shown in {props.options.productId}. Profile content is
                self-described; the host confirms who sent it, not who it depicts.
              </>
            )}
          </p>
        </div>
      </Modal.Body>
      <Modal.Actions testId="profile-drawer-actions">
        <Button
          ref={el => {
            closeButton = el;
          }}
          variant="secondary"
          block
          testId="profile-drawer-close"
          onClick={() => {
            props.onClose();
          }}
        >
          Close
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
