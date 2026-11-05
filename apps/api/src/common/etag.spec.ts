import { bytesEtag, jsonEtag } from './etag.js';

describe('jsonEtag', () => {
  it('is a weak ETag that depends only on the JSON body', () => {
    const etag = jsonEtag({ a: 1, b: [2] });
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{43}"$/);
    expect(jsonEtag({ a: 1, b: [2] })).toBe(etag);
    expect(jsonEtag({ a: 1, b: [3] })).not.toBe(etag);
    expect(jsonEtag({ a: 1, b: [2], computedAt: null })).not.toBe(etag);
  });
});

describe('bytesEtag', () => {
  it('matches jsonEtag for the same serialized bytes', () => {
    const body = { a: 1, b: [2] };
    expect(bytesEtag(Buffer.from(JSON.stringify(body)))).toBe(jsonEtag(body));
  });
});
