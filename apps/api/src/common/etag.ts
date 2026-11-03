import { createHash } from 'node:crypto';

/**
 * A weak ETag of a JSON response body: the SHA-256 of exactly what is sent, so it changes whenever
 * any byte of the response would (a rollup run, a turbine moving, a pruned day) and never
 * otherwise. Express answers a matching `If-None-Match` with 304 itself (`req.fresh` in
 * `res.send`) once the header is set; the query still runs, the body isn't sent.
 */
export function jsonEtag(body: unknown): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(body))
    .digest('base64url');
  return `W/"${hash}"`;
}
