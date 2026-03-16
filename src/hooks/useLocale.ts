import { useEffect, useState } from 'react';
import {
  getAppName,
  getLocalePreference,
  resolveLocale,
  setLocalePreference,
  subscribeLocaleChange,
  t,
  type LocalePreference,
} from '../i18n';

export function useLocale() {
  const [preference, setPreference] = useState<LocalePreference>(() => getLocalePreference());

  useEffect(() => {
    return subscribeLocaleChange(() => {
      setPreference(getLocalePreference());
    });
  }, []);

  const locale = resolveLocale(preference);

  return {
    locale,
    localePreference: preference,
    setLocalePreference,
    appName: getAppName(locale),
    t: (key: Parameters<typeof t>[0]) => t(key, locale),
  };
}
