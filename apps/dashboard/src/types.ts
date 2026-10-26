// Shapes returned by the gateway API.

export type Role = "admin" | "member";

export interface Me {
  userId: number;
  email: string;
  role: Role;
}

export type ServerStatus = "connecting" | "connected" | "unreachable" | "disabled";
export type AuthType = "none" | "bearer" | "header";

export type ServerKind = "remote" | "hosted" | "store";

export interface HostedInfo {
  image: string;
  port: number;
  deployStatus: "deploying" | "running" | "failed" | "deleting";
  deployDetail: string | null;
  allowInternet: boolean;
}

export interface Server {
  kind: ServerKind;
  hosted?: HostedInfo;
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

export interface ToolRule {
  id: number;
  role: Role;
  upstream_slug: string;
  tool_pattern: string;
  effect: "allow" | "deny";
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

export type StoreStatus = "provisioning" | "ready" | "failed" | "deleting";

export interface Store {
  id: number;
  slug: string;
  name: string;
  owner: string | null;
  status: StoreStatus;
  statusDetail: string | null;
  url: string;
  namespace: string;
  createdAt: string;
  canManage: boolean;
  toolPrefix: string;
}

export interface ServerStats {
  server: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number | null;
  p95Ms: number | null;
  lastError: string | null;
}
