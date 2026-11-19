// Translation lookup for the test-only client-support snapshot. The UI module
// this replaces is built on i18next and React, which the harness does not need;
// this reads the same English catalogue so messages and placeholders match.
import en from "./locales/en.json" with { type: "json" };

type Vars = Record<string, string | number>;

function lookup(key: string): string {
  let value: unknown = en;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object") return key;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : key;
}

/** Translate a catalogue key, resolving `{{name}}` placeholders. */
export function t(key: string, vars?: Vars): string {
  const template = lookup(key);
  if (!vars) return template;
  return template.replace(/\{\{?(\w+)\}?\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Dates and numbers follow the host locale, as the default system preference did. */
export function formatLocale(): string | string[] {
  return [];
}

/** The snapshot never changes language; a subscription is accepted and ignored. */
export function subscribeLanguage(listener: () => void): () => void {
  void listener;
  return () => {};
}
