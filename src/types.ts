/** oidc-webpush — type definitions */

export interface User {
  sub: string;
  email: string;
  display_name: string | null;
  is_admin: number;
  created_at: number;
}

export interface Subscription {
  id: string;
  user_sub: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_seen: number;
}

export interface Rule {
  id: string;
  user_sub: string;
  position: number;
  match_field: 'from' | 'subject' | 'body';
  match_pattern: string;
  action: 'mute' | 'priority' | 'tag';
  action_value: string | null;
  enabled: number;
  app_name: string | null;
  created_at: number;
}

export interface Event {
  id: number;
  public_id: string | null;
  ts: number;
  user_sub: string | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  matched_rule: string | null;
  action_taken: string | null;
  delivered_count: number;
  failed_count: number;
  status: string;
  credential_name: string | null;
  body: string | null;
}

export interface Session {
  sid: string;
  user_sub: string;
  created_at: number;
  expires_at: number;
}

export interface SmtpCredential {
  id: string;
  user_sub: string;
  name: string;
  password_hash: string;
  enabled: number;
  created_at: number;
  last_used_at: number | null;
  message_count: number;
  error_count: number;
}

export interface AiResult {
  relevant: boolean;
  summary: string;
  priority?: number;
  reason?: string;
}

export interface EmailCtx {
  from: string;
  subject: string;
  body: string;
}
