/**
 * Redaction. The pattern net is a backstop; declared sensitivity is the real
 * protection. Both are tested here, including the limits of the net.
 */

import { describe, expect, it } from 'vitest';
import { createRedactor, fingerprint, SecretRegistry, summarizeForLog } from '../src/policy/redact.js';

describe('pattern redaction', () => {
  const r = createRedactor();

  it('scrubs tax ids, cards, emails and tokens', () => {
    expect(r.text('Tax ID 412-88-0031 on file')).toBe('Tax ID «tax-id» on file');
    expect(r.text('card 4111 1111 1111 1111')).toContain('«card»');
    expect(r.text('notify ops@example.com')).toBe('notify «email»');
    expect(r.text('Authorization: Bearer abc123def456ghi')).toContain('«token»');
  });

  it('does not mistake a versioned artifact filename for an email address', () => {
    // This was a live bug: the artifact path was being written to the log as
    // "capabilities/«email»", which makes the evidence useless.
    const path = 'capabilities/meridian.member.savings_balance@1.0.0.capability.yaml';
    expect(r.text(path)).toBe(path);
  });

  it('leaves a 5-digit member number alone, because that is sensitivity work', () => {
    // A member id is regulated but unrecognisable by pattern. It is protected by
    // its declared `sensitivity: pii-id`, not by this net.
    expect(r.text('member 12345')).toBe('member 12345');
  });

  it('scrubs recursively through nested structures, keys included', () => {
    const out = r.value({ a: ['413-99-1234'], b: { c: 'x@example.org' } });
    expect(JSON.stringify(out)).toBe('{"a":["«tax-id»"],"b":{"c":"«email»"}}');
  });

  it('reports which rules fired, for the artifact linter', () => {
    expect(r.findings('412-88-0031')).toContain('us-tax-id');
    expect(r.findings('nothing here')).toHaveLength(0);
  });
});

describe('SecretRegistry', () => {
  it('scrubs by exact value, which is the only reliable way', () => {
    const secrets = new SecretRegistry();
    secrets.register('meridian.password', 'hunter2-not-real');
    const r = createRedactor(secrets);
    expect(r.text('typed hunter2-not-real into the field')).toBe('typed «secret:meridian.password» into the field');
  });

  it('ignores values too short to scrub safely', () => {
    const secrets = new SecretRegistry();
    secrets.register('x', 'ab');
    expect(secrets.size()).toBe(0);
  });
});

describe('summarizeForLog', () => {
  it('keeps a correlatable fingerprint for identifiers without the identifier', () => {
    const a = summarizeForLog('12345', 'pii-id');
    expect(a).toBe(summarizeForLog('12345', 'pii-id'));
    expect(a).not.toContain('12345');
    expect(a).toContain(fingerprint('12345'));
  });

  it('keeps only the last four digits of an account', () => {
    expect(summarizeForLog('1234567890', 'account')).toBe('«account:…7890»');
  });

  it('reduces a name to its shape and a secret to nothing', () => {
    expect(summarizeForLog('DELACROIX, R M', 'pii')).toBe('«pii:14 chars»');
    expect(summarizeForLog('anything', 'secret')).toBe('«secret»');
  });

  it('passes non-sensitive values through, truncating very long ones', () => {
    expect(summarizeForLog('4182.55', 'none')).toBe('4182.55');
    expect(summarizeForLog('x'.repeat(300), 'none')).toHaveLength(201);
  });
});

describe('SecretRegistry bookkeeping', () => {
  it('reports whether a key has been registered', () => {
    const secrets = new SecretRegistry();
    expect(secrets.has('meridian.password')).toBe(false);
    secrets.register('meridian.password', 'demo-pass-not-real');
    expect(secrets.has('meridian.password')).toBe(true);
    expect(secrets.has('other.key')).toBe(false);
    expect(secrets.size()).toBe(1);
  });
});

describe('summarizeForLog on absent values', () => {
  it('reports null and undefined as themselves rather than masking them', () => {
    expect(summarizeForLog(null, 'pii')).toBe('null');
    expect(summarizeForLog(undefined, 'account')).toBe('undefined');
  });

  it('summarizes a non-string value of every sensitivity', () => {
    expect(summarizeForLog(4182.55, 'none')).toBe('4182.55');
    expect(summarizeForLog(12345, 'pii-id')).toContain('pii-id:');
  });
});

describe('redactor over non-string values', () => {
  it('leaves numbers, booleans and nulls alone while scrubbing nested strings', () => {
    const r = createRedactor();
    expect(r.value({ n: 1, b: true, z: null, s: '412-88-0031', arr: [1, 'x@y.com'] })).toEqual({
      n: 1,
      b: true,
      z: null,
      s: '«tax-id»',
      arr: [1, '«email»'],
    });
  });
});
