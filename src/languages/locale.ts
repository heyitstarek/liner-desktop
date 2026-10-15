export type Locale = "en" | "ru" | "uk";

const LOCALE_STORAGE_KEY = "liner_locale";

function getLocaleStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getStoredLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const storage = getLocaleStorage();
  if (!storage) return getBrowserLocale();
  let stored: string | null;
  try {
    stored = storage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return getBrowserLocale();
  }
  if (stored === "en" || stored === "ru" || stored === "uk") return stored;
  // Handle legacy stored 'ua'
  if (stored === "ua") {
    storeLocale("uk");
    return "uk";
  }
  return getBrowserLocale();
}

export function storeLocale(locale: Locale): void {
  const storage = getLocaleStorage();
  try { storage?.setItem(LOCALE_STORAGE_KEY, locale); } catch {}
}

export function getBrowserLocale(): Locale {
  if (typeof window === "undefined") return "ru";
  const langs = window.navigator.languages ?? [window.navigator.language];
  for (const l of langs) {
    const code = l.slice(0, 2).toLowerCase();
    if (code === "en") return "en";
    if (code === "ru") return "ru";
    if (code === "uk" || code === "ua") return "uk";
  }
  return "ru";
}
