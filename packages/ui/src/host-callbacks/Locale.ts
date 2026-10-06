import type { LocaleHost } from "@parity/truapi-host";
import type { HostLocaleSubscribeItem } from "@parity/truapi";
import { createResultStream } from "./result-stream";

export function createLocaleSubscribe(): LocaleHost["subscribeLocale"] {
  return () =>
    createResultStream<HostLocaleSubscribeItem>(
      [{ languageTag: navigator.language }],
      (push) => {
        const changed = (): void => {
          push({ languageTag: navigator.language });
        };
        window.addEventListener("languagechange", changed);
        return () => {
          window.removeEventListener("languagechange", changed);
        };
      },
    );
}
