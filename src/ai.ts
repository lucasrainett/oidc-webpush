/** oidc-webpush — Ollama AI integration */

import { config } from './config.js';
import { buildPrompt } from './utils.js';
import type { AiResult } from './types.js';

// ── Semaphore ───────────────────────────────────────────────────────────────

interface Queued { resolve: () => void }

const semaphore = {
  count: config.ollama.maxConcurrency,
  queue: [] as Queued[],
};

function acquire(): Promise<void> {
  if (semaphore.count > 0) {
    semaphore.count--;
    return Promise.resolve();
  }
  return new Promise((resolve) => semaphore.queue.push({ resolve }));
}

function release(): void {
  if (semaphore.queue.length > 0) {
    const next = semaphore.queue.shift()!;
    next.resolve();
  } else {
    semaphore.count++;
  }
}

// ── Call Ollama ────────────────────────────────────────────────────────────

export async function callOllama(
  subject: string,
  from: string,
  body: string,
): Promise<AiResult | null> {
  await acquire();
  const queueTimer = setTimeout(() => release(), config.ollama.queueTimeoutMs);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ollama.timeoutMs);

    const res = await fetch(`${config.ollama.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.model,
        prompt: buildPrompt(subject, from, body),
        stream: false,
        format: 'json',
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = (await res.json()) as { response: string };
    const parsed = JSON.parse(data.response) as Partial<AiResult>;

    return {
      relevant: Boolean(parsed.relevant),
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 140) : '',
      priority: typeof parsed.priority === 'number' ? Math.min(5, Math.max(1, Math.round(parsed.priority))) : 3,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(queueTimer);
    release();
  }
}

// ── Bypass / Skip helpers ─────────────────────────────────────────────────

export function matchesBypassPattern(text: string): boolean {
  if (!config.aiBypassPatterns.length) return false;
  const regex = new RegExp(config.aiBypassPatterns.join('|'), 'i');
  return regex.test(text);
}

export function matchesSkipPattern(text: string): boolean {
  if (!config.aiSkipPatterns.length) return false;
  const regex = new RegExp(config.aiSkipPatterns.join('|'), 'i');
  return regex.test(text);
}
