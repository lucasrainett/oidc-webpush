/** oidc-webpush — configuration from environment variables */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  baseUrl: required('BASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  smtpPort: Number(process.env.SMTP_PORT ?? 2525),
  smtpHost: process.env.SMTP_HOST ?? '0.0.0.0',
  oidc: {
    issuer: required('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
  },
  vapid: {
    public: process.env.VAPID_PUBLIC ?? '',
    private: process.env.VAPID_PRIVATE ?? '',
    subject: process.env.VAPID_SUBJECT ?? 'mailto:admin@localhost',
  },
  cookieSecret: required('COOKIE_SECRET'),
  dbPath: process.env.DB_PATH ?? './data/oidc-webpush.db',
  adminEmails: new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
  ollama: {
    url: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'llama3.2:3b',
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 5000),
    maxConcurrency: Number(process.env.OLLAMA_MAX_CONCURRENCY ?? 2),
    queueTimeoutMs: Number(process.env.OLLAMA_QUEUE_TIMEOUT_MS ?? 120000),
  },
  aiBypassPatterns: (process.env.AI_BYPASS_PATTERNS ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean),
  aiSkipPatterns: (process.env.AI_SKIP_PATTERNS ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean),
  aiFilterDefault: (process.env.AI_FILTER_DEFAULT ?? 'true') === 'true',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  smtpEndpoint: process.env.SMTP_ENDPOINT || '',
} as const;

export function hasVapidKeys(): boolean {
  return Boolean(config.vapid.public && config.vapid.private);
}
