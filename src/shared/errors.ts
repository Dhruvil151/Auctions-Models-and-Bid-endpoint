export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
export const unavailable = () => new ApiError(503, 'RETRY_REQUIRED', 'Result unavailable. Retry with the same Idempotency-Key.');
