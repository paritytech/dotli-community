// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The browser's own status of a device permission, read without a prompt, and its prompt for Notifications.

import { createReporter, defineCount } from '@dotli/metrics';
import { ALL_PERMISSIONS, getBrowserCheck, type EnforceablePermissionName } from './permissionPolicy.js';

/** What the browser says of a permission, `unknown` where it cannot say. */
export type BrowserPermissionStatus = 'granted' | 'denied' | 'prompt' | 'unknown';

export type BrowserPermissions = ReturnType<typeof createBrowserPermissions>;

/** True when the browser blocks the permission, so a grant in dot.li does not reach the app. */
export function isBrowserBlocked(status: BrowserPermissionStatus): boolean {
  switch (status) {
    case 'denied':
      return true;
    case 'granted':
    case 'prompt':
    case 'unknown':
      return false;
  }
}

type Params = {
  /** The page's Notification API, null where the browser has none. */
  notifications: () => Pick<typeof Notification, 'permission' | 'requestPermission'> | null;
  /** The page's Permissions API, null where the browser has none. */
  permissions: () => Pick<Permissions, 'query'> | null;
};

const report = createReporter({ flow: 'permissions' });

/** A browser query of a permission's status that rejected, as a browser does for a name it does not know. */
const browserReadMetric = defineCount<'error'>('permissions.browser_read');

/** A browser prompt for a permission that rejected, which leaves its status unknown. */
const browserRequestMetric = defineCount<'error'>('permissions.browser_request');

/** Reads the browser's permissions through the APIs `params` returns, read on each call. */
export function createBrowserPermissions({ notifications, permissions }: Params) {
  return {
    /** The permissions the browser reports a status for, in menu order. */
    checked: ALL_PERMISSIONS.map(({ name }) => name).filter(name => getBrowserCheck(name) !== null),

    /** The browser's status of `name`, `unknown` where it cannot say. Never rejects and never prompts. */
    async read(name: EnforceablePermissionName): Promise<BrowserPermissionStatus> {
      const check = getBrowserCheck(name);
      switch (check) {
        case null:
          return 'unknown';
        case 'notifications': {
          const api = notifications();
          return api === null ? 'unknown' : getNotificationStatus(api.permission);
        }
        case 'camera':
        case 'microphone':
        case 'geolocation': {
          const api = permissions();
          if (api === null) {
            return 'unknown';
          }
          try {
            const { state } = await api.query({ name: check });
            return state;
          } catch (error) {
            report.expected(error, { step: 'browser_permission_read', metric: browserReadMetric });
            return 'unknown';
          }
        }
      }
    },

    /**
     * Asks the browser for `name` and resolves its answer, null where the host does not ask the browser for `name` or
     * the browser has no API for it. A caller calls it inside the user's click, as the browser prompts only within a
     * user gesture. Never rejects.
     */
    request(name: EnforceablePermissionName): Promise<BrowserPermissionStatus> | null {
      switch (getBrowserCheck(name)) {
        case 'notifications':
          return requestNotifications();
        case null:
        case 'camera':
        case 'microphone':
        case 'geolocation':
          return null;
      }
    },
  };

  function requestNotifications(): Promise<BrowserPermissionStatus> | null {
    const api = notifications();
    if (api === null) {
      return null;
    }
    return api.requestPermission().then(getNotificationStatus, (error: unknown): BrowserPermissionStatus => {
      report.expected(error, { step: 'browser_permission_request', metric: browserRequestMetric });
      return 'unknown';
    });
  }
}

/** The page's browser permissions, over the window's own APIs. */
export const browserPermissions = createBrowserPermissions({
  notifications: () => ('Notification' in window ? window.Notification : null),
  permissions: () => ('permissions' in navigator ? navigator.permissions : null),
});

function getNotificationStatus(permission: NotificationPermission): BrowserPermissionStatus {
  switch (permission) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'default':
      return 'prompt';
  }
}
