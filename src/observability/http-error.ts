import { HttpError } from '../venues/http.js';

/**
 * Extract status + body from an HTTP error so event details capture the venue's actual rejection reason, not just
 * "HTTP 400". Returns an empty object for non-HTTP errors. Shared across every catch block that records an error
 * event for an HTTP-backed action (orders, exits, liquidations, balance/position fetches) so we can always reach
 * the venue's response on post-hoc forensic review.
 */
export function httpErrorDetails(error: unknown): { httpStatus?: number; httpBody?: unknown } {
  if (!(error instanceof HttpError)) return {};
  return {
    httpStatus: error.status,
    httpBody: error.body
  };
}
