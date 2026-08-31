import type { LocaleHost } from "@parity/truapi-host";
import type { HostLocaleSubscribeItem } from "@parity/truapi";
import { createResultStream } from "./result-stream";

// dotli presents English chrome and has no language setting of its own, so the
// visitor's browser preference is the only real signal a product can localize
// against. A product that does not ship the tag picks its own fallback.
function currentLocale(): HostLocaleSubscribeItem {
  return { languageTag: navigator.language };
}

export function createLocaleSubscribe(): Required<LocaleHost>["subscribeLocale"] {
  return () =>
    createResultStream<HostLocaleSubscribeItem>([currentLocale()], (push) => {
      const onLanguageChanged = (): void => {
        push(currentLocale());
      };
      window.addEventListener("languagechange", onLanguageChanged);
      return () => {
        window.removeEventListener("languagechange", onLanguageChanged);
      };
    });
}
