#!/bin/sh
# Writes the Angular app's runtime config (served as /config.json) from API_BASE_URL, and the API
# origin for the Content-Security-Policy's connect-src (an nginx map include, see
# default.conf.template). Runs from the nginx image's /docker-entrypoint.d before nginx starts: a missing or invalid URL
# exits non-zero, so the container (and the Cloud Run revision) never starts with a bad API URL.
#
# API_BASE_URL is the public API base URL + "/api" (Terraform sets it from the `api_url` output).
# Rules (the same as the former build-time check): a URL, https, not an example.com/.org/.net
# placeholder, path ends with "/api", no query or fragment; surrounding whitespace and trailing
# slashes are dropped. http is accepted only for loopback hosts (docker compose, local runs). The
# host must be a DNS name or IPv4 address (letters, digits, dots, hyphens): it goes into the CSP
# header verbatim, and a CSP source can't express an IPv6 literal such as [::1].
#
# Tested by docker/runtime-config.test.mts (npm run test:docker).
set -eu

out=${RUNTIME_CONFIG_FILE:-/usr/share/nginx/runtime/config.json}
# Included by default.conf.template inside `map ... $nextera_api_origin { ... }`. This script runs
# after the entrypoint's envsubst step (20-envsubst-on-templates.sh), so an env var would be too
# late for the template: nginx reads this file when it starts, right after.
origin_out=${RUNTIME_API_ORIGIN_FILE:-/usr/share/nginx/runtime/api-origin.map}

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
  \[*) fail "API_BASE_URL must use a host name or IPv4 address (a CSP can't allow an IPv6 literal): \"$raw\"." ;;
  *) host=${authority%%:*} ;;
esac
port=${authority#"$host"}
case $port in
  '' | :) port= ;;
  :*[!0-9]*) fail "API_BASE_URL is not a valid URL: \"$raw\"." ;;
  :*) ;;
  *) fail "API_BASE_URL is not a valid URL: \"$raw\"." ;;
esac
host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
# DNS labels or an IPv4 address only: nothing that could end a CSP source (';', ',', spaces) or be
# read by nginx as a variable ('$').
if ! printf '%s' "$host" | LC_ALL=C grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'; then
  fail "API_BASE_URL is not a valid URL: \"$raw\"."
fi

if [ "$scheme" = http ]; then
  case $host in
    localhost | 127.0.0.1) ;;
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

# The API origin (scheme + lower-case host + explicit port) for connect-src.
origin=$scheme://$host$port

# Write atomically: nginx never serves a half-written file.
printf '{"apiBaseUrl":"%s"}\n' "$raw" >"$out.tmp"
printf 'default "%s";\n' "$origin" >"$origin_out.tmp"
mv "$out.tmp" "$out"
mv "$origin_out.tmp" "$origin_out"
echo "nextera-web: API base URL $raw (CSP connect-src $origin)"
