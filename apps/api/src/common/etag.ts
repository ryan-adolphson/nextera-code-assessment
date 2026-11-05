import { createHash } from 'node:crypto';

/**
 * A weak ETag of a response body: the SHA-256 of exactly the bytes sent, so it changes whenever
 * any byte of the response would (a rollup run, a turbine moving, a pruned day) and never
 * otherwise. Express answers a matching `If-None-Match` with 304 itself (`req.fresh` in
 * `res.send`) once the header is set; the query still runs, the body isn't sent.
 */
export function bytesEtag(bytes: Buffer | string): string {
  return `W/"${createHash('sha256').update(bytes).digest('base64url')}"`;
}

/** The ETag of a JSON response body: `bytesEtag` of its `JSON.stringify`. */
export function jsonEtag(body: unknown): string {
  return bytesEtag(JSON.stringify(body));
}
