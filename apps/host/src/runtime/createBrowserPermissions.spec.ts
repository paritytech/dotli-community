// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { recordReports } from '@dotli/metrics/testing';
import { createBrowserPermissions } from './createBrowserPermissions.js';

type CreateParams = {
  /** The page's Notification API, or null when the browser has none. */
  notifications?: FakeNotifications | null;
  /** The page's Permissions API, or null when the browser has none. */
  permissions?: FakePermissions | null;
};

type FakeNotifications = {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
};

type FakePermissions = {
  query: (descriptor: PermissionDescriptor) => Promise<PermissionStatus>;
};

describe('createBrowserPermissions', () => {
  it('As a dotli user whose browser grants notifications, I read Notifications and get granted', async () => {
    // Given
    const permissions = create({ notifications: fakeNotifications('granted') });

    // When
    const status = await permissions.read('Notifications');

    // Then
    expect(status).toBe('granted');
  });

  it('As a dotli user whose browser has not decided notifications, I read Notifications and get prompt', async () => {
    // Given
    const permissions = create({ notifications: fakeNotifications('default') });

    // When
    const status = await permissions.read('Notifications');

    // Then
    expect(status).toBe('prompt');
  });

  it('As a dotli user in a browser with no Notification API, I read and request Notifications and get unknown and no request', async () => {
    // Given
    const permissions = create({ notifications: null });

    // When
    const status = await permissions.read('Notifications');
    const request = permissions.request('Notifications');

    // Then
    expect(status).toBe('unknown');
    expect(request).toBeNull();
  });

  it('As a dotli user, I read Camera, Microphone and Location and the browser is queried by name', async () => {
    // Given
    const query = vi.fn((_descriptor: PermissionDescriptor) => Promise.resolve(fakeStatus('denied')));
    const permissions = create({ permissions: { query } });

    // When
    const statuses = await Promise.all([
      permissions.read('Camera'),
      permissions.read('Microphone'),
      permissions.read('Location'),
    ]);

    // Then
    expect(statuses).toEqual(['denied', 'denied', 'denied']);
    expect(query.mock.calls.map(([descriptor]) => descriptor)).toEqual([
      { name: 'camera' },
      { name: 'microphone' },
      { name: 'geolocation' },
    ]);
  });

  it('As a dotli user in a browser that cannot query a permission, I read it and get unknown', async () => {
    // Given
    const rejecting = create({ permissions: { query: () => Promise.reject(new TypeError('Unsupported permission')) } });
    const missing = create({ permissions: null });

    // When
    const statuses = await Promise.all([rejecting.read('Camera'), missing.read('Camera')]);

    // Then
    expect(statuses).toEqual(['unknown', 'unknown']);
  });

  it('As a dotli user, I read a permission with no browser check and the browser is not asked', async () => {
    // Given
    const query = vi.fn((_descriptor: PermissionDescriptor) => Promise.resolve(fakeStatus('granted')));
    const permissions = create({ permissions: { query } });

    // When
    const statuses = await Promise.all([permissions.read('ChainSubmit'), permissions.read('Motion')]);

    // Then
    expect(statuses).toEqual(['unknown', 'unknown']);
    expect(query).not.toHaveBeenCalled();
  });

  it('As a dotli user, I approve Notifications and the browser is asked once', async () => {
    // Given
    const requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>('granted'));
    const permissions = create({ notifications: { permission: 'default', requestPermission } });

    // When
    const status = await permissions.request('Notifications');

    // Then
    expect(status).toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I approve a permission the host does not ask the browser for and nothing is asked', () => {
    // Given
    const permissions = create({});

    // When
    const request = permissions.request('Camera');

    // Then
    expect(request).toBeNull();
  });

  it('As a dotli user whose browser fails the request, the failure is counted and the request reads unknown', async () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const permissions = create({
      notifications: {
        permission: 'default',
        requestPermission: () => Promise.reject(new Error('Request blocked')),
      },
    });

    // When
    const status = await permissions.request('Notifications');

    // Then
    expect(status).toBe('unknown');
    expect(reports.expected).toMatchObject([{ step: 'browser_permission_request' }]);
  });
});

function create({ notifications = fakeNotifications('default'), permissions = null }: CreateParams) {
  return createBrowserPermissions({
    notifications: () => notifications,
    permissions: () => permissions,
  });
}

function fakeNotifications(permission: NotificationPermission): FakeNotifications {
  return { permission, requestPermission: () => Promise.resolve(permission) };
}

function fakeStatus(state: PermissionState): PermissionStatus {
  return Object.assign(new EventTarget(), { name: 'fake', state, onchange: null });
}
