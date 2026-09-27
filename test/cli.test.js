import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatSalary } from '../src/cli.js';

/**
 * cli.js only runs main() when it is the script Node was started with, so
 * importing it here is side-effect free.
 *
 * Grouping separators come from toLocaleString(), which follows the machine
 * locale, so expected strings are built the same way rather than hardcoded.
 */

const n = (value) => value.toLocaleString();

describe('formatSalary', () => {
  test('prints both bounds with the currency and no unit for yearly pay', () => {
    const salary = { min: 87500, max: 111000, currency: 'GBP', period: 'year', source: 'ats' };
    assert.equal(formatSalary(salary), `${n(87500)}-${n(111000)} GBP`);
  });

  test('prints a min-only range as "from" without an undefined max', () => {
    const salary = { min: 520000, max: null, currency: 'INR', period: 'year', source: 'ats' };
    assert.equal(formatSalary(salary), `from ${n(520000)} INR`);
  });

  test('prints a max-only range as "up to" with the monthly unit', () => {
    const salary = { min: null, max: 2450, currency: 'EUR', period: 'month', source: 'ats' };
    assert.equal(formatSalary(salary), `up to ${n(2450)} EUR/mo`);
  });

  test('appends /hr for hourly pay', () => {
    const salary = { min: 45, max: 60, currency: 'USD', period: 'hour', source: 'text' };
    assert.equal(formatSalary(salary), '45-60 USD/hr');
  });

  test('omits the unit when the period is unknown', () => {
    const salary = { min: 80000, max: null, currency: 'CAD', period: null, source: 'ats' };
    assert.equal(formatSalary(salary), `from ${n(80000)} CAD`);
  });
});
