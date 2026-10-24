import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(400, message);
  }
  return result.data;
}

export function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid id");
  return id;
}

/** Postgres unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "23505";
}

// CSRF: the session cookie is SameSite=Strict, and every state-changing API
// call must also carry a custom header, which a cross-site form can't send.
export function requireCsrfHeader(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.header("x-requested-with") === "urumi-dashboard") {
    next();
    return;
  }
  res.status(403).json({ error: "Missing X-Requested-With header" });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("unhandled error", err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
}
