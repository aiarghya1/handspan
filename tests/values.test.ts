/**
 * Typed inputs and outputs. Input validation runs before the browser opens, so
 * a bad caller argument is never mistaken for an application validation error.
 */

import { describe, expect, it } from 'vitest';
import { applyTransform, checkOutputs, InputValidationError, validateInputs } from '../src/replay/values.js';
import type { ParamSpec, ReturnSpec } from '../src/artifact/schema.js';

const params: Record<string, ParamSpec> = {
  memberId: { type: 'string', description: 'member number', required: true, pattern: '^\\d{5}$', sensitivity: 'pii-id' },
  productCode: { type: 'string', description: 'product', required: true, enum: ['SV02', 'VC01'], sensitivity: 'none' },
  amount: { type: 'money', description: 'deposit', required: false, minimum: 0, sensitivity: 'none' },
};

describe('validateInputs', () => {
  it('accepts valid inputs', () => {
    expect(validateInputs(params, { memberId: '12345', productCode: 'VC01', amount: '25.00' })).toEqual({
      memberId: '12345',
      productCode: 'VC01',
      amount: '25.00',
    });
  });

  it('rejects a value that fails the declared pattern, before any browser opens', () => {
    // If this reached the screen it would come back as an application
    // validation error, indistinguishable from a genuine business outcome.
    expect(() => validateInputs(params, { memberId: '123', productCode: 'VC01' })).toThrow(InputValidationError);
  });

  it('never echoes the offending value, because parameters are often PII', () => {
    try {
      validateInputs(params, { memberId: '999-88-7777', productCode: 'VC01' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('999-88-7777');
      expect(String(err)).toContain('^\\d{5}$');
    }
  });

  it('rejects a value outside a declared enum', () => {
    expect(() => validateInputs(params, { memberId: '12345', productCode: 'ZZ99' })).toThrow(/must be one of/);
  });

  it('rejects an undeclared parameter rather than silently ignoring it', () => {
    expect(() => validateInputs(params, { memberId: '12345', productCode: 'VC01', branch: '004' })).toThrow(
      /not a declared parameter/,
    );
  });

  it('requires required parameters and tolerates optional ones', () => {
    expect(() => validateInputs(params, { productCode: 'VC01' })).toThrow(/"memberId" is required/);
    expect(validateInputs(params, { memberId: '12345', productCode: 'VC01' })).not.toHaveProperty('amount');
  });

  it('enforces numeric bounds', () => {
    expect(() => validateInputs(params, { memberId: '12345', productCode: 'VC01', amount: '-5' })).toThrow(/below minimum/);
  });
});

describe('applyTransform', () => {
  it('parses money out of whatever the screen rendered', () => {
    expect(applyTransform('  4,182.55 ', 'money')).toBe(4182.55);
    expect(applyTransform('$913.20', 'money')).toBe(913.2);
    expect(applyTransform('-25.00', 'money')).toBe(-25);
  });

  it('parses integers and collapses whitespace for text', () => {
    expect(applyTransform('Sfx 0075', 'integer')).toBe(75);
    expect(applyTransform('  DELACROIX,   R M ', 'trim')).toBe('DELACROIX, R M');
    expect(applyTransform('active', 'upper')).toBe('ACTIVE');
  });

  it('returns null rather than NaN when there is nothing to parse', () => {
    expect(applyTransform('no digits', 'money')).toBeNull();
  });
});

describe('checkOutputs', () => {
  const returns: Record<string, ReturnSpec> = {
    savingsBalance: { type: 'money', description: 'balance', sensitivity: 'account', required: true },
    memberNote: { type: 'string', description: 'note', sensitivity: 'none', required: false },
  };

  it('reports a missing required return', () => {
    expect(checkOutputs(returns, {})).toEqual(['declared return "savingsBalance" was not produced']);
  });

  it('reports a return of the wrong type', () => {
    expect(checkOutputs(returns, { savingsBalance: '4182.55' })[0]).toContain('should be a money');
  });

  it('passes when every required return is present and well typed', () => {
    expect(checkOutputs(returns, { savingsBalance: 4182.55 })).toEqual([]);
  });
});

describe('numeric validation', () => {
  const numeric: Record<string, ParamSpec> = {
    amount: { type: 'money', description: 'deposit', required: true, minimum: 10, maximum: 100, sensitivity: 'none' },
    count: { type: 'integer', description: 'how many', required: true, sensitivity: 'none' },
  };

  it('rejects something that is not a number at all', () => {
    expect(() => validateInputs(numeric, { amount: 'twelve', count: '1' })).toThrow(/must be a number/);
  });

  it('rejects a fractional value for an integer parameter', () => {
    expect(() => validateInputs(numeric, { amount: '50', count: '1.5' })).toThrow(/must be an integer/);
  });

  it('enforces both bounds', () => {
    expect(() => validateInputs(numeric, { amount: '5', count: '1' })).toThrow(/below minimum 10/);
    expect(() => validateInputs(numeric, { amount: '500', count: '1' })).toThrow(/above maximum 100/);
    expect(validateInputs(numeric, { amount: '50', count: '2' })).toEqual({ amount: '50', count: '2' });
  });

  it('reports every problem at once rather than one per attempt', () => {
    try {
      validateInputs(numeric, { amount: '500', count: 'x' });
      expect.unreachable();
    } catch (err) {
      expect((err as { issues: string[] }).issues).toHaveLength(2);
    }
  });
});

describe('transforms that find nothing', () => {
  it('returns null for a number with no digits in it', () => {
    expect(applyTransform('n/a', 'number')).toBeNull();
    expect(applyTransform('none', 'integer')).toBeNull();
  });

  it('parses a plain number and a negative integer', () => {
    expect(applyTransform('12.5', 'number')).toBe(12.5);
    expect(applyTransform('-3 items', 'integer')).toBe(-3);
  });
});

describe('checkOutputs for every declared type', () => {
  it('accepts an optional return that is absent, and flags a wrong-typed number', () => {
    const returns: Record<string, ReturnSpec> = {
      note: { type: 'string', description: 'note', sensitivity: 'none', required: false },
      count: { type: 'integer', description: 'count', sensitivity: 'none', required: true },
      amount: { type: 'number', description: 'amount', sensitivity: 'none', required: true },
    };
    expect(checkOutputs(returns, { count: 3, amount: 1.5 })).toEqual([]);
    expect(checkOutputs(returns, { count: '3', amount: 1.5 })[0]).toContain('should be a integer');
    expect(checkOutputs(returns, { count: 3, amount: null })[0]).toContain('was not produced');
  });
});

describe('values that look numeric but are not', () => {
  it('returns null rather than NaN', () => {
    expect(applyTransform('1-2-3', 'money')).toBeNull();
    expect(applyTransform('1-2-3', 'number')).toBeNull();
    expect(applyTransform('--', 'integer')).toBeNull();
  });
});
