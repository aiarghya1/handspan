/**
 * Value templating. The interesting property is the boundary: parameters and
 * extracted values may be logged subject to sensitivity, secrets never are.
 */

import { describe, expect, it } from 'vitest';
import { SecretRegistry } from '../src/policy/redact.js';
import {
  EnvSecretResolver,
  resolveTemplate,
  templateReferences,
  templateTouchesSecret,
  TemplateError,
} from '../src/artifact/template.js';

const secrets = { get: (k: string) => (k === 'meridian.password' ? 'demo-pass-not-real' : undefined) };

describe('resolveTemplate', () => {
  const ctx = { params: { memberId: '12345' }, outputs: { ref: '8831-2001' }, secrets, baseUrl: 'http://app.test' };

  it('substitutes parameters, outputs and the base url', () => {
    expect(resolveTemplate('{{memberId}}', ctx)).toBe('12345');
    expect(resolveTemplate('{{out:ref}}', ctx)).toBe('8831-2001');
    expect(resolveTemplate('{{baseUrl}}/member/search', ctx)).toBe('http://app.test/member/search');
  });

  it('registers a resolved secret so the redactor can scrub it afterwards', () => {
    const registry = new SecretRegistry();
    const value = resolveTemplate('{{secret:meridian.password}}', { ...ctx, secretRegistry: registry });
    expect(value).toBe('demo-pass-not-real');
    expect(registry.scrub(`typed ${value}`)).toBe('typed «secret:meridian.password»');
  });

  it('refuses an unknown reference instead of substituting an empty string', () => {
    // Typing "" into a member number field returns an application validation
    // error, which is far harder to diagnose than refusing to run.
    expect(() => resolveTemplate('{{nope}}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplate('{{out:missing}}', ctx)).toThrow(/no output named/);
    expect(() => resolveTemplate('{{secret:absent}}', ctx)).toThrow(/not available/);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(resolveTemplate('{{ memberId }}', ctx)).toBe('12345');
  });
});

describe('helpers', () => {
  it('detects templates that pull in a secret', () => {
    expect(templateTouchesSecret('{{secret:x}}')).toBe(true);
    expect(templateTouchesSecret('{{memberId}}')).toBe(false);
    expect(templateTouchesSecret(undefined)).toBe(false);
  });

  it('lists every reference, for static validation of an artifact', () => {
    expect(templateReferences('{{a}}/{{secret:b}}/{{out:c}}')).toEqual(['a', 'secret:b', 'out:c']);
  });
});

describe('EnvSecretResolver', () => {
  it('maps a vault key onto an environment variable name', () => {
    process.env['TEST_VAULT_KEY'] = 'value';
    expect(new EnvSecretResolver().get('test.vault.key')).toBe('value');
    delete process.env['TEST_VAULT_KEY'];
  });
});

describe('missing context', () => {
  it('refuses a base url reference when none was supplied', () => {
    expect(() => resolveTemplate('{{baseUrl}}/x', { params: {}, outputs: {}, secrets })).toThrow(/no baseUrl supplied/);
  });

  it('refuses a parameter that is declared but empty', () => {
    const ctx = { params: { memberId: undefined }, outputs: {}, secrets };
    expect(() => resolveTemplate('{{memberId}}', ctx)).toThrow(/has no value/);
    expect(() => resolveTemplate('{{memberId}}', { ...ctx, params: { memberId: null } })).toThrow(/has no value/);
  });

  it('resolves a secret without a registry attached', () => {
    expect(resolveTemplate('{{secret:meridian.password}}', { params: {}, outputs: {}, secrets })).toBe('demo-pass-not-real');
  });

  it('leaves text with no references untouched', () => {
    expect(resolveTemplate('/member/search', { params: {}, outputs: {}, secrets })).toBe('/member/search');
    expect(templateReferences('no references here')).toEqual([]);
  });

  it('carries the template and the reference on the error, for a clear message', () => {
    try {
      resolveTemplate('{{nope}}', { params: {}, outputs: {}, secrets });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError);
      expect((err as TemplateError).reference).toBe('nope');
      expect((err as TemplateError).template).toBe('{{nope}}');
    }
  });
});
