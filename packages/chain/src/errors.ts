import type { ChainErrorCode } from "./types.ts";

/**
 * A typed chain failure. The message is static text written here (it may name the
 * provider), never an SDK trace, a token, a request value or an identifier, so
 * services can return it as is.
 */
export class ChainError extends Error {
  readonly code: ChainErrorCode;
  constructor(code: ChainErrorCode, message: string) {
    super(message);
    this.name = "ChainError";
    this.code = code;
  }
}
