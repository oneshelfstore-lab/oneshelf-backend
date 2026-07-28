import type { Response } from "express";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown[],
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown[]) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(404, "NOT_FOUND", `${entity} with id '${id}' not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}

/**
 * The 500 branch, shared by [sendError] and middleware/errorHandler's globalErrorHandler so the two
 * can't drift apart (they already did once: only the middleware minted a ref, so every 500 raised
 * from a route's own catch block — i.e. all ~374 sendError call sites — came back untraceable).
 *
 * A 500 is by definition an unhandled cause: the stack only lives in the server logs and the app has
 * no way to point at it. Stamp a short ref on both so "An unexpected error occurred (ref: k3f9c2)"
 * read off a phone screen greps straight to the stack in the Railway logs.
 *
 * [req] is optional so sendError doesn't have to be threaded through every call site — it falls back
 * to `res.req`, express's own circular reference (set in app.handle before routing, so it is always
 * populated inside a route handler). Read defensively: a synthetic/mock Response would otherwise
 * throw INSIDE the error handler and turn a clean 500 into a hung request with no response at all.
 */
export function send500WithRef(
  res: Response,
  error: unknown,
  req?: { method?: string; originalUrl?: string },
) {
  const ref = Math.random().toString(36).slice(2, 8);
  const src: { method?: string; originalUrl?: string } | undefined = req ?? res.req;
  console.error(`Unhandled error [ref ${ref}] ${src?.method ?? "?"} ${src?.originalUrl ?? "?"}:`, error);
  return res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: `An unexpected error occurred (ref: ${ref})`,
      details: [],
    },
  });
}

export function sendError(res: Response, error: unknown) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? [],
      },
    });
  }

  return send500WithRef(res, error);
}
