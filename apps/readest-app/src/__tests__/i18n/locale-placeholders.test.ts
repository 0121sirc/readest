import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

/**
 * `pnpm i18n:extract` stamps `__STRING_NOT_TRANSLATED__` as the value of every
 * key that still needs a translation — a marker for the translation pass, not
 * content. Nothing at runtime rewrites it: i18next looks the key up, finds a
 * value, and returns it verbatim, so a shipped placeholder makes the UI print
 * `__STRING_NOT_TRANSLATED__` instead of falling back to the English key (see
 * the WebDAV endpoint-change dialog).
 *
 * Shipped locale files must therefore leave untranslated keys ABSENT. With no
 * value to return, i18next falls back to the key itself, which under
 * key-as-content IS the English string.
 */
const LOCALES_DIR = resolve(process.cwd(), 'public/locales');
const NOT_TRANSLATED = '__STRING_NOT_TRANSLATED__';

describe('shipped locale files', () => {
  test('never carry the extractor s not-translated placeholder', () => {
    const locales = readdirSync(LOCALES_DIR, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    expect(locales.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const { name } of locales) {
      const raw = readFileSync(resolve(LOCALES_DIR, name, 'translation.json'), 'utf-8');
      const entries = Object.entries(JSON.parse(raw) as Record<string, string>);
      for (const [key, value] of entries) {
        if (value === NOT_TRANSLATED) offenders.push(`${name}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
