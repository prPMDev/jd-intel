import { createHash } from 'node:crypto';

/**
 * Generate a stable ID for a job posting.
 */
export function jobId(company, title, ats, location = '') {
  // Location is part of identity: the same role posted in multiple
  // offices is distinct requisitions with distinct URLs. Omitting it
  // collapsed multi-office postings to one id (see issue #17).
  const raw = `${company}|${title}|${ats}|${location}`.toLowerCase().trim();
  return createHash('md5').update(raw).digest('hex').substring(0, 12);
}

/**
 * Normalize a raw ATS job object into the unified schema.
 *
 * Adapters pass `description` as HTML. This is the one place it is
 * stripped and decoded (issue #66): a second pass would delete text the
 * author escaped on purpose (`&lt;5 years`) and leave entities the first
 * pass exposed (`&amp;mdash;` -> `&mdash;`) as literal noise.
 *
 * `raw.workplace` is the ATS's own arrangement, already mapped by the
 * adapter to 'remote' | 'hybrid' | 'onsite', or null when the platform
 * gives no signal. `raw.locations` lists every place the posting is open
 * in; `location` stays the primary because it feeds the id (issue #68).
 */
export function normalize(raw, ats) {
  const now = new Date().toISOString();
  const description = stripHtml(raw.description || '');
  const location = raw.location || '';
  const workplace = resolveWorkplace(raw.workplace, location);
  return {
    id: jobId(raw.company || raw.companySlug, raw.title, ats, location),
    company: raw.company || raw.companySlug || '',
    companySlug: raw.companySlug || '',
    ats,
    title: raw.title || '',
    department: raw.department || '',
    location,
    locations: uniqueLocations(location, raw.locations),
    locationType: workplace.type,
    workplace,
    salary: raw.salary || extractSalaryFromText(description),
    description,
    url: raw.url || '',
    postedAt: raw.postedAt || null,
    firstSeen: now,
    lastSeen: now,
    status: 'open',
    metadata: raw.metadata || {},
  };
}

const CURRENCY_CODES = 'USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|INR|SGD|HKD|JPY|CNY|BRL|MXN|ZAR|AED|ILS';
const SYMBOL_CURRENCY = { $: 'USD', '€': 'EUR', '£': 'GBP' };

// A number as job posts write it: 1,234,567 / 1.234.567 / 1234, with an
// optional one- or two-digit decimal part (211.4, 40.50, 60.000,50).
// Exactly three digits after a dot are a thousands group, the way Dutch
// and German boards write it: "€60.000" is sixty thousand, not sixty.
const NUMBER =
  '\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?' +
  '|\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?' +
  '|\\d+(?:[.,]\\d{1,2})?';

// One side of a range: optional code before, optional symbol, the number,
// optional K, optional code after. The lookarounds keep the number from
// starting or ending inside a longer one ("234.567" out of "1.234.567").
const amountPattern = (p) =>
  `(?:\\b(?<${p}CodeBefore>${CURRENCY_CODES})\\s?)?` +
  `(?<${p}Sym>[$€£])?\\s?` +
  `(?<![\\d.,])(?<${p}Num>${NUMBER})(?!\\d|[.,]\\d)\\s?` +
  `(?<${p}K>[kK]\\b)?` +
  `(?:\\s?(?<${p}CodeAfter>${CURRENCY_CODES})\\b)?`;

const SALARY_RANGE = new RegExp(
  `${amountPattern('lo')}\\s*(?:[-–—]|\\bto\\b)\\s*${amountPattern('hi')}`,
  'g'
);

const HOUR_RE = /\b(?:per|an|each)\s+hour\b|\/\s*(?:hr|hour)\b|\bhourly\b/i;
const MONTH_RE = /\b(?:per|a|each)\s+month\b|\/\s*(?:mo|month)\b|\bmonthly\b/i;
const YEAR_RE = /\b(?:per|a|each)\s+(?:year|annum)\b|\/\s*(?:yr|year)\b|\b(?:annual(?:ly|ized)?|yearly)\b/i;

/**
 * Extract a salary range from decoded job text.
 *
 * Accepts hyphen, en dash, em dash or "to" between the two amounts, an
 * optional ISO currency code before, between or after them, `$` / EUR /
 * GBP symbols, decimal K shorthand ($211.4K), and thousands grouped with
 * either a comma or a dot (60,000 and 60.000 are both sixty thousand).
 * A code wins over a symbol, so "$120,000 - $150,000 CAD" is CAD. Ranges
 * with no currency marker at all (years, headcounts) are ignored.
 *
 * @returns {{min:number,max:number,currency:string,period:('year'|'month'|'hour'|null),source:'text'}|null}
 */
export function extractSalaryFromText(text) {
  if (!text) return null;
  for (const m of text.matchAll(SALARY_RANGE)) {
    const g = m.groups;
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 40);
    // "$20 - $30 million" is a revenue figure, not pay.
    if (/^\s*(?:million|billion|m|bn?)\b/i.test(after)) continue;

    const code = g.loCodeBefore || g.loCodeAfter || g.hiCodeBefore || g.hiCodeAfter;
    const sym = g.loSym || g.hiSym;
    if (!code && !sym) continue;

    let min = parseAmount(g.loNum);
    let max = parseAmount(g.hiNum);
    if (g.loK || g.hiK) {
      // "$150-200K" carries the K once for both sides.
      if (min < 1000) min = Math.round(min * 1000);
      if (max < 1000) max = Math.round(max * 1000);
    }
    if (!(min > 0) || !(max > 0)) continue;

    const before = text.slice(Math.max(0, m.index - 40), m.index);
    return {
      min,
      max,
      currency: (code || SYMBOL_CURRENCY[sym]).toUpperCase(),
      period: detectPeriod(before, after, min),
      source: 'text',
    };
  }
  return null;
}

// Dots grouping thousands mean a comma is the decimal mark, and vice versa.
function parseAmount(s) {
  if (/^\d{1,3}(?:\.\d{3})+/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  return Number(s.replace(/,(?=\d{3})/g, '').replace(',', '.'));
}

function detectPeriod(before, after, min) {
  const explicit = periodWord(after) || periodWord(before);
  if (explicit) return explicit;
  return min >= 10000 ? 'year' : null;
}

function periodWord(text) {
  if (HOUR_RE.test(text)) return 'hour';
  if (MONTH_RE.test(text)) return 'month';
  if (YEAR_RE.test(text)) return 'year';
  return null;
}

const WORKPLACE_TYPES = new Set(['remote', 'hybrid', 'onsite']);

/**
 * The platform's own value wins. Without one, a keyword in the location
 * string is the next best signal. Without either the type is 'unknown':
 * a city name alone does not say the role is onsite, and a guessed
 * 'onsite' reads as a fact to whoever consumes it.
 *
 * @returns {{type:('remote'|'hybrid'|'onsite'|'unknown'), source:('ats'|'text'|null)}}
 */
function resolveWorkplace(native, location) {
  if (WORKPLACE_TYPES.has(native)) return { type: native, source: 'ats' };
  const guessed = workplaceFromText(location);
  if (guessed) return { type: guessed, source: 'text' };
  return { type: 'unknown', source: null };
}

function workplaceFromText(location) {
  const lower = (location || '').toLowerCase();
  if (/remote/.test(lower)) return 'remote';
  if (/hybrid/.test(lower)) return 'hybrid';
  if (/on-?site/.test(lower)) return 'onsite';
  return null;
}

function uniqueLocations(primary, extra) {
  const out = [];
  const seen = new Set();
  for (const loc of [primary, ...(Array.isArray(extra) ? extra : [])]) {
    const s = typeof loc === 'string' ? loc.trim() : '';
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/**
 * Strip HTML tags and convert to clean text.
 *
 * Block closers become line breaks and list items become bullets before
 * the remaining tags are removed. Entities are decoded LAST, so a literal
 * `&lt;` in the source text never turns into a tag that gets stripped.
 */
export function stripHtml(html) {
  if (!html) return '';
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\/(?:li|div|td|tr|ul|ol|table|section)\s*>/gi, '\n')
    // Word-pasted markup (Lever lists, issue #64) opens a <p> inside each
    // <li>; swallowing it keeps the item text on the bullet's line.
    .replace(/<li\b[^>]*>\s*(?:<p\b[^>]*>\s*)?/gi, '- ')
    .replace(/<h[1-6]\b[^>]*>/gi, '## ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
  deg: '°', times: '×', euro: '€', pound: '£', yen: '¥', cent: '¢',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ',
  Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
};

/**
 * Decode one layer of entity encoding (and unwrap CDATA) to real text.
 *
 * Decimal and hex references go through String.fromCodePoint, named
 * references through the table above. `&amp;` is intentionally resolved
 * LAST so double-encoded sequences (`&amp;mdash;`, `&amp;amp;`) collapse
 * by exactly one layer per call. Used for the outer escaping Greenhouse
 * and the Teamtailor RSS feed apply, and as stripHtml's final step.
 */
export function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (m, dec) => codePointToString(parseInt(dec, 10), m))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, hex) => codePointToString(parseInt(hex, 16), m))
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name) =>
      (name !== 'amp' && Object.hasOwn(NAMED_ENTITIES, name)) ? NAMED_ENTITIES[name] : m)
    .replace(/&amp;/g, '&');
}

function codePointToString(cp, fallback) {
  if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return fallback;
  return String.fromCodePoint(cp);
}
