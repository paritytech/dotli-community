// dot.li — Permission storage
//
// Persists host-level permission decisions per product in localStorage.
// Device permissions that map to a Permissions Policy directive also
// gate the iframe `allow` attribute (granting/revoking reloads the
// iframe); variants without a directive are policy-only.
//
// Permission status: 'ask' (default), 'granted', or 'denied'.

import type { DevicePermission } from "@truapi/client";

export type DevicePermissionName = DevicePermission["tag"];

export type PermissionName =
  | DevicePermissionName
  | "ChainSubmit"
  | "PreimageSubmit"
  | "StatementSubmit";

/** Device permissions the host can't actually gate (see AUTO_GRANT_DEVICE_PERMISSIONS). */
export type AutoGrantDevicePermission = "Notifications" | "OpenUrl";

/** Device permissions that DO have a host-side enforcement point. */
export type EnforceableDevicePermission = Exclude<
  DevicePermissionName,
  AutoGrantDevicePermission
>;

/** Permissions the host actually surfaces to the user (popover + modal). */
export type EnforceablePermissionName = Exclude<
  PermissionName,
  AutoGrantDevicePermission
>;

export type PermissionStatus = "ask" | "granted" | "denied";

/**
 * Map from Host API device permission names to Permissions Policy directives.
 *
 * Only variants with a browser-level enforcement point are listed. Granting
 * a variant absent from this map is still recorded in localStorage but
 * does not alter the iframe `allow` attribute.
 */
export const DEVICE_PERMISSION_POLICY: Partial<
  Record<DevicePermissionName, string>
> = {
  Camera: "camera",
  Microphone: "microphone",
  Location: "geolocation",
  Bluetooth: "bluetooth",
  // Clipboard write is always granted by dot.li (see buildAllowAttribute);
  // the read directive requires explicit consent.
  Clipboard: "clipboard-read",
  // WebAuthn — covers the Biometrics variant for hosts that expose it via
  // passkeys / platform authenticators.
  Biometrics: "publickey-credentials-get",
  // Chromium-only; harmless to include on browsers that ignore it.
  NFC: "nfc",
  // Notifications and OpenUrl are not gated by a Permissions Policy
  // directive — the browser Notifications API has its own prompt, and
  // cross-origin navigation is controlled by the anchor/window.open path.
};

/**
 * Device permissions whose enforcement is outside the host's reach:
 *   - Notifications — the browser has its own prompt (Notifications.requestPermission)
 *   - OpenUrl      — cross-origin navigation happens via anchor / window.open
 * Requests for these always resolve `true` and they are hidden from the
 * settings popover — offering a control that can't actually block would
 * mislead users.
 */
export const AUTO_GRANT_DEVICE_PERMISSIONS: ReadonlySet<AutoGrantDevicePermission> =
  new Set<AutoGrantDevicePermission>(["Notifications", "OpenUrl"]);

/** Type guard: narrows `DevicePermissionName` past the auto-grant set. */
export function isEnforceableDevicePermission(
  name: DevicePermissionName,
): name is EnforceableDevicePermission {
  return !(AUTO_GRANT_DEVICE_PERMISSIONS as ReadonlySet<string>).has(name);
}

/** All permissions shown in the topbar menu, in display order. */
export const ALL_PERMISSIONS: readonly {
  name: EnforceablePermissionName;
  label: string;
}[] = [
  { name: "Camera", label: "Camera" },
  { name: "Microphone", label: "Microphone" },
  { name: "Location", label: "Location" },
  { name: "Bluetooth", label: "Bluetooth" },
  { name: "NFC", label: "NFC" },
  { name: "Clipboard", label: "Clipboard" },
  { name: "Biometrics", label: "Biometrics" },
  { name: "ChainSubmit", label: "Sign Transactions" },
  { name: "PreimageSubmit", label: "Submit Preimages" },
  { name: "StatementSubmit", label: "Submit Statements" },
];

/** Returns true if the permission name maps to an iframe `allow` directive. */
export function isDevicePermission(name: string): boolean {
  return name in DEVICE_PERMISSION_POLICY;
}

// ── Storage helpers ──────────────────────────────────────

const STORAGE_PREFIX = "dotli:permissions:";

type StoredPermissions = Record<string, PermissionStatus>;

function storageKey(label: string): string {
  return STORAGE_PREFIX + label;
}

function readStored(label: string): StoredPermissions {
  try {
    const raw = localStorage.getItem(storageKey(label));
    if (raw === null) {
      return {};
    }
    return JSON.parse(raw) as StoredPermissions;
  } catch {
    return {};
  }
}

function writeStored(label: string, data: StoredPermissions): void {
  localStorage.setItem(storageKey(label), JSON.stringify(data));
}

// ── Public API ───────────────────────────────────────────

export function getPermissionStatus(
  label: string,
  permission: PermissionName,
): PermissionStatus {
  return readStored(label)[permission] ?? "ask";
}

export function setPermissionStatus(
  label: string,
  permission: PermissionName,
  status: PermissionStatus,
): void {
  const data = readStored(label);
  data[permission] = status;
  writeStored(label, data);
}

export function resetPermission(
  label: string,
  permission: PermissionName,
): void {
  const data = readStored(label);
  const { [permission]: _, ...rest } = data;
  writeStored(label, rest);
}

/** Returns the list of device permission names that have been granted. */
export function getGrantedDevicePermissions(
  label: string,
): DevicePermissionName[] {
  const data = readStored(label);
  return Object.entries(data)
    .filter(
      ([name, status]) => status === "granted" && isDevicePermission(name),
    )
    .map(([name]) => name as DevicePermissionName);
}

/** Returns true if any permission (device or remote) is granted. */
export function hasAnyGrant(label: string): boolean {
  const data = readStored(label);
  return Object.values(data).some((status) => status === "granted");
}

/**
 * Build the iframe `allow` attribute value from granted device permissions.
 * Always includes `clipboard-write`; adds Permissions Policy directives
 * for each granted device permission.
 */
export function buildAllowAttribute(label: string): string {
  const policies = ["clipboard-write"];
  for (const name of getGrantedDevicePermissions(label)) {
    const directive = DEVICE_PERMISSION_POLICY[name];
    if (directive !== undefined) {
      policies.push(directive);
    }
  }
  return policies.join("; ");
}
