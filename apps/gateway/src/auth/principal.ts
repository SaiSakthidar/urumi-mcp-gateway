export type Role = "admin" | "member";

/** Who is making a request. Comes from a session cookie (dashboard/chat) or an API key (/mcp). */
export interface Principal {
  userId: number;
  email: string;
  role: Role;
  apiKeyId?: number;
}
