/**
 * Fail-loud companion errors. Messages name the code and the next action.
 * They must never include memory text, prompts, or API keys.
 *
 * @module dsh-companion/errors
 */

export class CompanionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompanionError";
    this.code = code;
  }
}

export function asCompanionError(error: unknown, code: string, message: string): CompanionError {
  if (error instanceof CompanionError) return error;
  return new CompanionError(code, message, { cause: error });
}
