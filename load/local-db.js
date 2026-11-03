const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * LOAD_DATABASE_URL, which must point at this machine; there is deliberately no fallback to
 * DATABASE_URL. `?host=` and `?hostaddr=` override the URL's host in libpq-style URLs, and this
 * repo's Cloud SQL URLs have the form `user:pass@localhost/db?host=/cloudsql/<connection>`, so
 * they are checked too. It can't see through a TCP proxy listening on localhost.
 */
export function localDatabaseUrl(env = process.env) {
  const value = env.LOAD_DATABASE_URL;
  if (!value) throw new Error('Set LOAD_DATABASE_URL (a local database).');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('LOAD_DATABASE_URL is not a valid URL.');
  }
  const hosts = [
    url.hostname,
    url.searchParams.get('host'),
    url.searchParams.get('hostaddr'),
  ].filter((host) => host !== null);
  const remote = hosts.find((host) => !LOCAL_HOSTS.has(host));
  if (!/^postgres(ql)?:$/.test(url.protocol) || remote !== undefined) {
    // The host only: the URL holds a password.
    throw new Error(
      `Refusing to run: LOAD_DATABASE_URL must be a local postgres URL (host "${remote ?? ''}").`,
    );
  }
  return value;
}
