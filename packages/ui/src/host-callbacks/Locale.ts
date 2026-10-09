import type { LocaleHost } from '@parity/truapi-host';
import type { HostLocaleSubscribeItem } from '@parity/truapi';
import { createResultStream } from './result-stream.js';

// dotli has no language setting, so the browser preference is the only signal a product can localize against.
function currentLocale(): HostLocaleSubscribeItem {
  return { languageTag: navigator.language };
}

export function createLocaleSubscribe(): Required<LocaleHost>['subscribeLocale'] {
  return () =>
    createResultStream<HostLocaleSubscribeItem>([currentLocale()], push => {
      const onLanguageChanged = (): void => {
        push(currentLocale());
      };
      window.addEventListener('languagechange', onLanguageChanged);
      return () => {
        window.removeEventListener('languagechange', onLanguageChanged);
      };
    });
}
