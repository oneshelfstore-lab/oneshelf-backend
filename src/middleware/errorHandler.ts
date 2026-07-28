import type { Request, Response, NextFunction } from "express";
import { AppError, send500WithRef } from "../lib/errors.js";
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

  // Ref-stamped 500 — see send500WithRef. Shared with sendError so a route that handles its own
  // errors and one that calls next(err) produce the same greppable ref format. `req` is passed
  // explicitly here since this handler already has it.
  return send500WithRef(res, err, req);
}
