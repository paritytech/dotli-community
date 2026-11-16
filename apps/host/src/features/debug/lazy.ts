import type * as ViolationPanelMountNamespace from './mount.js';
import type * as WireDescriberNamespace from './debugWireDescribe.js';

/**
 * Debug mode only. It reads every TrUAPI codec by name, so the bridge must not carry it. Rejects when its chunk fails
 * to load.
 */
export function loadWireDescriber(): Promise<typeof WireDescriberNamespace> {
  return import('./debugWireDescribe.js');
}

/** Sandbox checker builds only. Rejects when its chunk fails to load. */
export function loadViolationPanelMount(): Promise<typeof ViolationPanelMountNamespace> {
  return import('./mount.js');
}
