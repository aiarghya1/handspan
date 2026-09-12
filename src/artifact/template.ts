/**
 * Value templating for steps.
 *
 * Three reference forms, and the difference between them is a security
 * boundary, not a convenience:
 *
 *   {{memberId}}                 a declared input parameter
 *   {{secret:meridian.password}} a vault reference, resolved at action time
 *   {{out:confirmationNumber}}   a value extracted earlier in the same run
 *
 * Parameters and extracted values are substituted and may appear in logs
 * subject to their declared sensitivity. Secrets are substituted into the
 * action and into nothing else: the resolver registers them with the redactor
 * so that if one ever reaches a log line or a snapshot it is scrubbed on the
 * way out.
 *
 * Unknown references are an error rather than an empty string. Silently typing
 * "" into a member number field and getting a validation error back is a much
 * worse failure than refusing to run.
 */

import type { SecretRegistry } from '../policy/redact.js';

const REF = /\{\{\s*([a-zA-Z0-9_.:]+)\s*\}\}/g;

export class TemplateError extends Error {
  constructor(
    readonly template: string,
    readonly reference: string,
    reason: string,
  ) {
    super(`cannot resolve {{${reference}}} in "${template}": ${reason}`);
    this.name = 'TemplateError';
  }
}

export interface SecretResolver {
  /** Returns the secret value for a vault key, or undefined if unavailable. */
  get(key: string): string | undefined;
}

/**
 * Reads secrets from the process environment, mapping `meridian.password` to
 * `MERIDIAN_PASSWORD`. A real deployment swaps this for the institution's vault
 * client; nothing above this interface changes.
 */
export class EnvSecretResolver implements SecretResolver {
  get(key: string): string | undefined {
    return process.env[key.replace(/[.:-]/g, '_').toUpperCase()];
  }
}

export interface TemplateContext {
  params: Record<string, unknown>;
  outputs: Record<string, unknown>;
  secrets: SecretResolver;
  /** Secrets resolved here are registered so the redactor can scrub them. */
  secretRegistry?: SecretRegistry;
  /** Available as {{baseUrl}}; the tenant's entry point for this app. */
  baseUrl?: string;
}

export function resolveTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(REF, (_match, ref: string) => {
    if (ref === 'baseUrl') {
      if (ctx.baseUrl === undefined) throw new TemplateError(template, ref, 'no baseUrl supplied');
      return ctx.baseUrl;
    }
    if (ref.startsWith('secret:')) {
      const key = ref.slice('secret:'.length);
      const value = ctx.secrets.get(key);
      if (value === undefined) throw new TemplateError(template, ref, `secret "${key}" is not available`);
      ctx.secretRegistry?.register(key, value);
      return value;
    }
    if (ref.startsWith('out:')) {
      const key = ref.slice('out:'.length);
      if (!(key in ctx.outputs)) throw new TemplateError(template, ref, `no output named "${key}" yet`);
      return String(ctx.outputs[key]);
    }
    if (!(ref in ctx.params)) throw new TemplateError(template, ref, 'not a declared parameter');
    const v = ctx.params[ref];
    if (v === undefined || v === null) throw new TemplateError(template, ref, 'parameter has no value');
    return String(v);
  });
}

/** True when the template pulls in a secret, so its result must never be logged. */
export function templateTouchesSecret(template: string | undefined): boolean {
  if (!template) return false;
  return /\{\{\s*secret:/.test(template);
}

/** Every reference a template makes, for static validation of an artifact. */
export function templateReferences(template: string): string[] {
  return [...template.matchAll(REF)].map((m) => m[1]!);
}
