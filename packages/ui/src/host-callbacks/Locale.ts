import type { LocaleHost } from '@parity/truapi-host';
import type { HostLocaleSubscribeItem } from '@parity/truapi';
import { createResultStream } from './result-stream.js';

// dotli presents English chrome and has no language setting of its own, so the
// visitor's browser preference is the only real signal a product can localize
// against. A product that does not ship the tag picks its own fallback.
function currentLocale(): HostLocaleSubscribeItem {
  return {
    languageTag: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function createLocaleSubscribe(): Required<LocaleHost>['subscribeLocale'] {
  return () =>
    createResultStream<HostLocaleSubscribeItem>([], (push, pushError) => {
      let previous: HostLocaleSubscribeItem;
      try {
        previous = currentLocale();
        push(previous);
      } catch (error) {
        pushError({ reason: error instanceof Error ? error.message : String(error) });
        return () => {};
      }
      const onContextChanged = (): void => {
        try {
          const current = currentLocale();
          if (current.languageTag !== previous.languageTag || current.timeZone !== previous.timeZone) {
            previous = current;
            push(current);
          }
        } catch (error) {
          pushError({ reason: error instanceof Error ? error.message : String(error) });
        }
      };
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') onContextChanged();
      };
      window.addEventListener('languagechange', onContextChanged);
      window.addEventListener('focus', onContextChanged);
      document.addEventListener('visibilitychange', onVisible);
      // Browsers have no timezonechange event, including while a tab stays focused.
      const timer = window.setInterval(onVisible, 60_000);
      return () => {
        window.removeEventListener('languagechange', onContextChanged);
        window.removeEventListener('focus', onContextChanged);
        document.removeEventListener('visibilitychange', onVisible);
        window.clearInterval(timer);
      };
    });
}
