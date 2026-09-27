import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml, decodeEntities, extractSalaryFromText, jobId, normalize } from '../src/normalizer.js';

describe('stripHtml', () => {
  test('removes basic tags', () => {
    assert.equal(stripHtml('<p>Hello <strong>world</strong></p>'), 'Hello world');
  });

  test('converts <li> to markdown bullets', () => {
    const input = '<ul><li>First</li><li>Second</li></ul>';
    assert.match(stripHtml(input), /- First/);
    assert.match(stripHtml(input), /- Second/);
  });

  test('decodes common HTML entities', () => {
    assert.equal(stripHtml('Tom &amp; Jerry'), 'Tom & Jerry');
    assert.equal(stripHtml('a &lt; b'), 'a < b');
  });

  test('handles empty input', () => {
    assert.equal(stripHtml(''), '');
    assert.equal(stripHtml(null), '');
  });

  // Issue #66: numeric entities used to be deleted (C++ -> C, 8+ years -> 8 years).
  test('decodes decimal entities (&#43; &#39; &#64;)', () => {
    assert.equal(stripHtml('C&#43;&#43;, and Python'), 'C++, and Python');
    assert.equal(stripHtml('8&#43; years'), '8+ years');
    assert.equal(stripHtml('Bachelor&#39;s degree'), "Bachelor's degree");
    assert.equal(stripHtml('jobs&#64;example.com'), 'jobs@example.com');
  });

  test('decodes hex entities (&#xa0; &#x2019;)', () => {
    assert.equal(stripHtml('5&#xa0;years'), '5 years');
    assert.equal(stripHtml('it&#x2019;s'), 'it’s');
  });

  test('decodes named entities (&mdash; &quot; &rsquo;)', () => {
    assert.equal(stripHtml('$165,000&mdash;$190,000'), '$165,000—$190,000');
    assert.equal(stripHtml('&quot;quoted&quot;'), '"quoted"');
    assert.equal(stripHtml('you&rsquo;re'), 'you’re');
    assert.equal(stripHtml('&nbsp;a&hellip;'), 'a…');
    assert.equal(stripHtml('caf&eacute;'), 'café');
  });

  test('leaves unknown names and invalid code points alone', () => {
    assert.equal(stripHtml('&bogus; &#0; &#xFFFFFF; &constructor;'), '&bogus; &#0; &#xFFFFFF; &constructor;');
  });

  test('breaks lines at </div>, </td> and </tr>', () => {
    assert.equal(stripHtml('<div>Range:</div><div>$165,000 USD</div><div>At Company</div>'), 'Range:\n$165,000 USD\nAt Company');
    assert.equal(stripHtml('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'), 'a\nb\n\nc');
  });

  test('bullets <li> elements that carry attributes', () => {
    assert.equal(stripHtml('<ul><li class="x">item one</li><li>item two</li></ul>'), '- item one\n- item two');
  });

  test('keeps text that was escaped on purpose (&lt;5 years)', () => {
    // Entities decode after tags are removed, so a literal < never
    // becomes a tag that gets stripped.
    assert.equal(
      stripHtml('<p>&lt;5 years of experience, &gt;3 shipped products</p>'),
      '<5 years of experience, >3 shipped products'
    );
  });
});

describe('decodeEntities', () => {
  test('unwraps CDATA and resolves &amp; last (one layer per call)', () => {
    assert.equal(decodeEntities('<![CDATA[x &amp;amp; y]]>'), 'x &amp; y');
    assert.equal(decodeEntities('&amp;mdash; &amp;lt;p&amp;gt;'), '&mdash; &lt;p&gt;');
  });

  test('decodes numeric and named references', () => {
    assert.equal(decodeEntities('&#39;&#x27;&apos;&quot;&lt;&gt;'), '\'\'\'"<>');
  });

  test('handles empty input', () => {
    assert.equal(decodeEntities(''), '');
    assert.equal(decodeEntities(null), '');
  });
});

describe('extractSalaryFromText', () => {
  const usd = (min, max, period = 'year') => ({ min, max, currency: 'USD', period, source: 'text' });

  test('hyphen range (the original case)', () => {
    assert.deepEqual(extractSalaryFromText('Range is $150,000 - $200,000 based on location.'), usd(150000, 200000));
  });

  test('em dash separator', () => {
    assert.deepEqual(extractSalaryFromText('$165,000—$190,000'), usd(165000, 190000));
  });

  test('en dash separator', () => {
    assert.deepEqual(extractSalaryFromText('$165,000 – $190,000'), usd(165000, 190000));
  });

  test('"to" separator', () => {
    assert.deepEqual(extractSalaryFromText('$165,000 to $190,000'), usd(165000, 190000));
  });

  test('USD code after each amount', () => {
    assert.deepEqual(extractSalaryFromText('$165,000 USD - $190,000 USD'), usd(165000, 190000));
  });

  test('currency code before the amounts', () => {
    assert.deepEqual(extractSalaryFromText('USD 165,000 - 190,000'), usd(165000, 190000));
  });

  test('EUR symbol', () => {
    assert.deepEqual(extractSalaryFromText('€60,000 - €80,000'), { min: 60000, max: 80000, currency: 'EUR', period: 'year', source: 'text' });
  });

  test('GBP symbol', () => {
    assert.deepEqual(extractSalaryFromText('£87,500 - £111,000'), { min: 87500, max: 111000, currency: 'GBP', period: 'year', source: 'text' });
  });

  test('CAD suffix wins over the $ symbol', () => {
    assert.deepEqual(extractSalaryFromText('$120,000 - $150,000 CAD'), { min: 120000, max: 150000, currency: 'CAD', period: 'year', source: 'text' });
  });

  test('decimal K values', () => {
    assert.deepEqual(extractSalaryFromText('$211.4K - $290.6K'), usd(211400, 290600));
  });

  test('K written once applies to both sides ($150-200K)', () => {
    assert.deepEqual(extractSalaryFromText('$150-200K'), usd(150000, 200000));
  });

  test('dot-grouped thousands (60.000 is sixty thousand, not sixty)', () => {
    const eur = (min, max, period) => ({ min, max, currency: 'EUR', period, source: 'text' });
    assert.deepEqual(extractSalaryFromText('€ 60.000 - € 80.000 per year'), eur(60000, 80000, 'year'));
    assert.deepEqual(extractSalaryFromText('€4.500 - €5.500 per maand'), eur(4500, 5500, null));
    assert.deepEqual(extractSalaryFromText('€60.000,50 - €80.000,00'), eur(60000.5, 80000, 'year'));
  });

  test('never matches inside a longer number', () => {
    assert.deepEqual(extractSalaryFromText('€1.234.567 - €2.345.678'), { min: 1234567, max: 2345678, currency: 'EUR', period: 'year', source: 'text' });
    assert.deepEqual(extractSalaryFromText('$1,234.56 - $2,345.67'), usd(1234.56, 2345.67, null));
  });

  test('one- and two-digit decimals stay decimals', () => {
    assert.deepEqual(extractSalaryFromText('$40.50 - $55.75 per hour'), usd(40.5, 55.75, 'hour'));
  });

  test('"per hour" and "/hr" set period hour', () => {
    assert.deepEqual(extractSalaryFromText('$40 - $55 per hour'), usd(40, 55, 'hour'));
    assert.deepEqual(extractSalaryFromText('$40-$55/hr'), usd(40, 55, 'hour'));
  });

  test('"per month" sets period month', () => {
    assert.deepEqual(extractSalaryFromText('$5,000 - $7,000 per month'), usd(5000, 7000, 'month'));
  });

  test('a period label before the range counts too', () => {
    assert.equal(extractSalaryFromText('Hourly rate: $40 - $55').period, 'hour');
    assert.equal(extractSalaryFromText('Annual Base Salary Range:\n$165,000—$190,000 USD\n').period, 'year');
  });

  test('period defaults to year for annual-looking numbers, null otherwise', () => {
    assert.equal(extractSalaryFromText('$150,000 - $200,000').period, 'year');
    assert.equal(extractSalaryFromText('$40 - $55').period, null);
  });

  test('ignores ranges with no currency marker', () => {
    assert.equal(extractSalaryFromText('2020 - 2024, 5 - 7 years of experience'), null);
  });

  test('ignores revenue figures ($20 - $30 million)', () => {
    assert.equal(extractSalaryFromText('We grew from $20 - $30 million ARR.'), null);
  });

  test('returns null for empty input', () => {
    assert.equal(extractSalaryFromText(''), null);
    assert.equal(extractSalaryFromText(null), null);
  });
});

describe('jobId', () => {
  test('is deterministic for same inputs', () => {
    const a = jobId('stripe', 'Senior PM', 'greenhouse');
    const b = jobId('stripe', 'Senior PM', 'greenhouse');
    assert.equal(a, b);
  });

  test('differs when any field differs', () => {
    const base = jobId('stripe', 'Senior PM', 'greenhouse');
    assert.notEqual(base, jobId('stripe', 'Staff PM', 'greenhouse'));
    assert.notEqual(base, jobId('stripe', 'Senior PM', 'lever'));
  });

  test('is case-insensitive', () => {
    assert.equal(
      jobId('Stripe', 'Senior PM', 'greenhouse'),
      jobId('stripe', 'senior pm', 'greenhouse')
    );
  });

  test('distinguishes the same role across offices (issue #17)', () => {
    const sf = jobId('brex', 'Group Product Manager', 'greenhouse', 'San Francisco');
    const sea = jobId('brex', 'Group Product Manager', 'greenhouse', 'Seattle');
    const ny = jobId('brex', 'Group Product Manager', 'greenhouse', 'New York');
    assert.notEqual(sf, sea);
    assert.notEqual(sf, ny);
    assert.notEqual(sea, ny);
  });

  test('still deterministic with location', () => {
    assert.equal(
      jobId('brex', 'GPM', 'greenhouse', 'Remote - US'),
      jobId('brex', 'GPM', 'greenhouse', 'Remote - US')
    );
  });
});

describe('normalize', () => {
  test('maps a minimal raw job to the unified schema', () => {
    const raw = {
      company: 'stripe',
      title: 'Senior PM',
      location: 'Remote - US',
      description: '<p>Build things.</p>',
      url: 'https://boards.greenhouse.io/stripe/jobs/123',
    };
    const job = normalize(raw, 'greenhouse');

    assert.equal(job.company, 'stripe');
    assert.equal(job.title, 'Senior PM');
    assert.equal(job.ats, 'greenhouse');
    assert.equal(job.description, 'Build things.');
    assert.equal(job.status, 'open');
    assert.ok(job.id, 'id should be generated');
    assert.ok(job.firstSeen, 'firstSeen should be set');
  });

  test('detects remote locationType', () => {
    const job = normalize({ title: 'x', location: 'Remote - US' }, 'greenhouse');
    assert.equal(job.locationType, 'remote');
  });

  test('extracts salary from description text when no structured field', () => {
    const raw = {
      title: 'x',
      description: 'Range is $150,000 - $200,000 based on location.',
    };
    const job = normalize(raw, 'greenhouse');
    assert.deepEqual(job.salary, { min: 150000, max: 200000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('parses salary from the decoded description, not the raw HTML', () => {
    const raw = {
      title: 'x',
      description: '<div>Annual Base Salary Range:</div><div><span>$165,000</span><span>&mdash;</span><span>$190,000 USD</span></div>',
    };
    const job = normalize(raw, 'greenhouse');
    assert.deepEqual(job.salary, { min: 165000, max: 190000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('prefers a structured salary from the adapter over text', () => {
    const salary = { min: 1, max: 2, currency: 'EUR', period: null, source: 'ats' };
    const job = normalize({ title: 'x', description: '$150,000 - $200,000', salary }, 'ashby');
    assert.deepEqual(job.salary, salary);
  });

  test('returns null salary when nothing matches', () => {
    const job = normalize({ title: 'x', description: 'no dollars here' }, 'greenhouse');
    assert.equal(job.salary, null);
  });

  test('strips HTML exactly once, so escaped text survives', () => {
    const job = normalize({ title: 'x', description: '<p>&lt;5 years, C&#43;&#43;</p>' }, 'greenhouse');
    assert.equal(job.description, '<5 years, C++');
  });
});
