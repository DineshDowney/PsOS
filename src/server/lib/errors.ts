import { NextResponse } from "next/server";

/**
 * Application error with an HTTP status and a machine-readable code.
 * Route handlers wrap logic in `withErrorHandling` so every failure surfaces
 * as a structured JSON body — nothing fails silently.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, status = 400, detail?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function notFound(what: string, id?: string): AppError {
  return new AppError(
    "not_found",
    id ? `${what} '${id}' not found` : `${what} not found`,
    404,
  );
}

export function badRequest(message: string, detail?: unknown): AppError {
  return new AppError("bad_request", message, 400, detail);
}

type Handler<Ctx> = (req: Request, ctx: Ctx) => Promise<Response>;

export function withErrorHandling<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof AppError) {
        return NextResponse.json(
          { error: { code: err.code, message: err.message, detail: err.detail ?? null } },
          { status: err.status },
        );
      }
      console.error("[psos] unhandled error:", err);
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: { code: "internal_error", message } },
        { status: 500 },
      );
    }
  };
}
