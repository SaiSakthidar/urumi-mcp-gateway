// Shapes returned by the gateway API.

export type Role = "admin" | "member";

export interface Me {
  userId: number;
  email: string;
  role: Role;
}

export type ServerStatus = "connecting" | "connected" | "unreachable" | "disabled";
export type AuthType = "none" | "bearer" | "header";

export interface Server {
  id: number;
  slug: string;
  displayName: string;
  url?: string;
  authType: AuthType;
  authHeaderName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  status: ServerStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  tools: { name: string; description: string }[];
}

export interface Member {
  id: number;
  email: string;
  role: Role;
  status: "invited" | "active" | "disabled";
  created_at: string;
  active_keys: number;
}

export interface ApiKey {
  id: number;
  user_id: number;
  user_email: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  user_id: number | null;
  user_email: string | null;
  source: "mcp" | "chat";
  api_key_prefix: string | null;
  upstream_slug: string | null;
  tool_name: string | null;
  duration_ms: number | null;
  outcome: string;
  error_message: string | null;
}
