/** oidc-webpush — rules engine */

import { matchesPattern } from './utils.js';
import type { Rule, EmailCtx } from './types.js';

export function evalRules(rules: Rule[], email: EmailCtx): Rule | null {
  for (const r of rules) {
    if (!r.enabled) continue;
    const haystack = email[r.match_field] ?? '';
    if (matchesPattern(haystack, r.match_pattern)) return r;
  }
  return null;
}
