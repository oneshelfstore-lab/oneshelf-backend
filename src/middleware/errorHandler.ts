import type { Request, Response, NextFunction } from "express";
import { AppError } from "../lib/errors.js";
import { ZodError } from "zod";

export function globalErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details ?? [] },
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: err.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      },
    });
  }

  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_JSON", message: "Malformed JSON in request body", details: [] },
    });
  }

  // A 500 is by definition an unhandled cause — the stack only lives in the server logs, and the
  // app has no way to point at it. Stamp a short ref on both so "an unexpected error occurred
  // (ref: k3f9c2)" read off a phone screen greps straight to the stack in the Railway logs.
  const ref = Math.random().toString(36).slice(2, 8);
  console.error(`Unhandled error [ref ${ref}] ${req.method} ${req.originalUrl}:`, err);
  return res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: `An unexpected error occurred (ref: ${ref})`,
      details: [],
    },
  });
}
