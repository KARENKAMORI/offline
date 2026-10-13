/**
 * Normalised phone numbers and names, used to recognise the same patient. Identical to
 * HMIS/patients/identity.py and HMISMobile (HMIS/DOCUMENT_SCHEMA.md, "Duplicate patients"); a
 * change here needs a matching change in both.
 */

const KENYA_PREFIX = '+254';

/** Python's str.isspace() set, which differs from JS \s (no \ufeff, adds \x1c-\x1f and \x85). */
const PHONE_SEPARATORS =
  /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\-().]/g;

/**
 * Kenyan numbers become +2547XXXXXXXX / +2541XXXXXXXX; others keep their digits.
 *
 * 0712111222, 712111222, 254712111222, +254712111222 and 00254712111222 all give +254712111222.
 * A number already in +<country> form is kept as given.
 */
export function normalizePhone(raw: string | null | undefined): string {
  let number = (raw ?? '').replace(PHONE_SEPARATORS, '');
  if (number.startsWith('00')) number = '+' + number.slice(2);
  if (number.startsWith('+')) return number;
  // Python counts code points, not UTF-16 units.
  const length = [...number].length;
  if (length === 12 && number.startsWith('254')) return '+' + number;
  if (length === 10 && number[0] === '0' && '17'.includes(number[1])) return KENYA_PREFIX + number.slice(1);
  if (length === 9 && '17'.includes(number[0])) return KENYA_PREFIX + number;
  return number;
}

/**
 * Case, accents, punctuation, spacing and word order do not matter.
 *
 * "Grace Njeri", "njeri  GRACE" and "Grace-Njeri" all give "grace njeri".
 */
export function normalizeName(raw: string | null | undefined): string {
  const text = casefold(
    [...(raw ?? '').normalize('NFKD')].filter((ch) => !isCombining(ch)).join(''),
  );
  // Python's [^\W_] for str: letters and numbers. Marks are not word characters there.
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  // Python sorts by code point; JS sorts by UTF-16 unit, which differs only above U+FFFF.
  return words.sort(byCodePoint).join(' ');
}

/**
 * unicodedata.combining(ch) != 0. JS has no canonical combining class lookup, so ask NFD: it
 * reorders a mark with a non-zero class past its neighbours, and never moves a class 0 one.
 */
function isCombining(ch: string): boolean {
  if (!/\p{M}/u.test(ch)) return false;
  // U+0345 has the highest class in use (240), U+0334 the lowest (1).
  const high = 'a\u0345' + ch;
  const low = 'a' + ch + '\u0334';
  return high.normalize('NFD') !== high || low.normalize('NFD') !== low;
}

/** str.casefold(): full lowercase plus the folds toLowerCase() leaves out. */
function casefold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ')
    .replace(/[\u13f8-\u13fd]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 8))
    .replace(/[\uab70-\uabbf]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xab70 + 0x13a0))
    .replace(/[\u1c80-\u1c88]/g, (c) => CYRILLIC_VARIANTS[c.charCodeAt(0) - 0x1c80]);
}

const CYRILLIC_VARIANTS = ['в', 'д', 'о', 'с', 'т', 'т', 'ъ', 'ѣ', 'ꙋ'];

function byCodePoint(a: string, b: string): number {
  const x = [...a].map((c) => c.codePointAt(0)!);
  const y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
