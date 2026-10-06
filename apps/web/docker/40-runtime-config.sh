#!/bin/sh
# Writes the Angular app's runtime config (served as /config.json) from API_BASE_URL.
# Runs from the nginx image's /docker-entrypoint.d before nginx starts: a missing or invalid URL
# exits non-zero, so the container (and the Cloud Run revision) never starts with a bad API URL.
#
# API_BASE_URL is the public API base URL + "/api" (Terraform sets it from the `api_url` output).
# Rules (the same as the former build-time check): a URL, https, not an example.com/.org/.net
# placeholder, path ends with "/api", no query or fragment; surrounding whitespace and trailing
# slashes are dropped. http is accepted only for loopback hosts (docker compose, local runs).
#
# Tested by docker/runtime-config.test.mts (npm run test:docker).
set -eu

out=${RUNTIME_CONFIG_FILE:-/usr/share/nginx/runtime/config.json}

fail() {
  echo "nextera-web: $*" >&2
  exit 1
}

raw=$(printf '%s' "${API_BASE_URL-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's:/*$::')

if [ -z "$raw" ]; then
  fail 'API_BASE_URL is not set: use the Terraform `api_url` output + "/api" (e.g. https://api.mydomain.com/api).'
fi

# One line of URL characters only (no whitespace, quotes or backslashes), so the value can be
# written into JSON without escaping.
nl='
'
case $raw in *"$nl"*) fail "API_BASE_URL is not a valid URL: \"$raw\"." ;; esac
if ! printf '%s' "$raw" | LC_ALL=C grep -Eq '^[][A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'; then
  fail "API_BASE_URL is not a valid URL: \"$raw\"."
fi

case $raw in
  https://*) scheme=https rest=${raw#https://} ;;
  http://*) scheme=http rest=${raw#http://} ;;
  [A-Za-z]*://*) fail "API_BASE_URL must use https: \"$raw\"." ;;
  *) fail "API_BASE_URL is not a valid URL: \"$raw\"." ;;
esac

# authority = host[:port]; the rest is path + query + fragment.
authority=${rest%%[/?#]*}
path=${rest#"$authority"}
case $authority in
  *@*) fail "API_BASE_URL must not contain credentials: \"$raw\"." ;;
  \[*\]*) host=${authority%%\]*}] ;;
  *) host=${authority%%:*} ;;
esac
port=${authority#"$host"}
case $port in
  '' | :) ;;
  :*[!0-9]*) fail "API_BASE_URL is not a valid URL: \"$raw\"." ;;
  :*) ;;
  *) fail "API_BASE_URL is not a valid URL: \"$raw\"." ;;
esac
host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
if [ -z "$host" ]; then
  fail "API_BASE_URL is not a valid URL: \"$raw\"."
fi

if [ "$scheme" = http ]; then
  case $host in
    localhost | 127.0.0.1 | '[::1]') ;;
    *) fail "API_BASE_URL must use https (http only for localhost): \"$raw\"." ;;
  esac
fi

if printf '%s' "$host" | grep -Eq '(^|\.)example\.(com|org|net)$'; then
  fail "API_BASE_URL is still a placeholder: \"$raw\"."
fi

case $path in
  *[?#]*) fail "API_BASE_URL must end with \"/api\" (no query or fragment): \"$raw\"." ;;
  */api) ;;
  *) fail "API_BASE_URL must end with \"/api\" (no query or fragment): \"$raw\"." ;;
esac

# Write atomically: nginx never serves a half-written file.
printf '{"apiBaseUrl":"%s"}\n' "$raw" >"$out.tmp"
mv "$out.tmp" "$out"
echo "nextera-web: API base URL $raw"
