/** oidc-webpush — utility helpers */

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

export function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function matchesPattern(haystack: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(haystack);
  } catch {
    return haystack.toLowerCase().includes(pattern.toLowerCase());
  }
}

export function buildPrompt(subject: string, from: string, body: string): string {
  const truncatedBody = body.slice(0, 4000);
  return `You are an email triage assistant. Given an email, respond with JSON:
{ "relevant": boolean, "summary": "...", "priority": number, "reason": "..." }
- relevant: true if this is something a person would want to be notified about on their phone
- summary: one sentence, max 140 chars, captures the actionable content
- priority: 1 (low) to 5 (high), default 3
- reason: brief explanation of the relevance decision

Subject: ${subject}
From: ${from}
Body: ${truncatedBody}`;
}
