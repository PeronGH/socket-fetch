# Design

## Goal

A `fetch`-compatible HTTP/1.1 client built on a user-supplied socket API.
Published on JSR, written for Deno, and must run on Cloudflare Workers
(workerd).

## Interface

`createFetcher({ connect, connectTls })` returns `typeof fetch`.

- `connect` is used for `http:` URLs, `connectTls` for `https:`. The library
  never implements TLS.
- `Connect` is `(address: SocketAddress) => Socket | Promise<Socket>`.
  `Deno.connect`/`Deno.connectTls` and `cloudflare:sockets` `connect` satisfy it
  directly.
- The core module must not reference `Deno` or `cloudflare:*`.
- Customization (address overrides, CA certificates, proxies, logging) is done
  by wrapping `connect`/`connectTls`, not by fetcher options.

## Scope

- HTTP/1.1 only. `connectTls` must not negotiate another protocol via ALPN.
- No connection pooling: one connection per request, `Connection: close`.
  Workers sockets cannot be shared across requests.
- No `Upgrade` support.
- Browser-only fetch concerns (CORS, CSP, cookie jar, HTTP cache) are out of
  scope.

## Specifications

- [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112) HTTP/1.1: message syntax,
  body length (§6.3), chunked coding (§7.1), connection management and smuggling
  (§11).
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) HTTP Semantics: methods,
  status codes, bodiless responses, redirects, content coding, field syntax
  (§5).
- [WHATWG Fetch](https://fetch.spec.whatwg.org/): `fetch()` behavior, including
  redirect handling, abort, body extraction, and `Response` fields.
- [WHATWG URL](https://url.spec.whatwg.org/): provided by the runtime's `URL`.

## References

All permissively licensed. Retain copyright notices for any logic borrowed.

- [h11](https://github.com/python-hyper/h11) (MIT): sans-I/O HTTP/1.1, primary
  model for the protocol layer.
- [undici](https://github.com/nodejs/undici) (MIT): `lib/web/fetch/index.js` for
  Fetch algorithm steps, `lib/dispatcher/client-h1.js` for the HTTP/1.1 client.
- [llhttp](https://github.com/nodejs/llhttp) (MIT): strict parser and its
  lenient-mode flags.
- [Go net/http](https://github.com/golang/go/tree/master/src/net/http) (BSD-3):
  `transport.go`, `internal/chunked.go`.
- [httparse](https://github.com/seanmonstar/httparse) (MIT/Apache-2.0): header
  tokenizing.
- [web-platform-tests `fetch/`](https://github.com/web-platform-tests/wpt/tree/master/fetch)
  (BSD-3): conformance tests.

Do not read or port code from copyleft projects (e.g. `shadowfetch`, AGPL-3.0).

## Runtime built-ins

Rely on built-ins available in both Deno and workerd instead of reimplementing:

- `URL`: parsing, default ports, request target, redirect `Location` resolution.
- `Request`: normalizing `fetch` arguments, method normalization, body
  extraction and `Content-Type` (including multipart `FormData`).
- `Headers`: name/value validation, `getSetCookie()`.
- `Response`: status validation, null-body status checks.
- `TextEncoder`/`TextDecoder` (latin1 for header bytes).
- `DecompressionStream`.
- Web streams and `AbortSignal` (`AbortSignal.any`).

Runtime differences and constraints:

- workerd's `DecompressionStream` supports only `gzip`, `deflate`,
  `deflate-raw`. Only advertise and decode `gzip` and `deflate`.
- `Response` only accepts status 200–599. Consume 1xx interim responses; treat
  other out-of-range statuses as a network error.
- Neither runtime's `Headers` enforces forbidden request headers, so header
  policy is ours to define.
- `Response.url` and `Response.redirected` cannot be set via the constructor;
  define them on the instance. Verify on workerd.

## Implemented here

- Request serialization: request line, headers, `Content-Length` or chunked
  body.
- Response head parsing on bytes, with size limits.
- Body framing per RFC 9112 §6.3, chunked decoding as a `TransformStream`.
- Fetch layer: redirects, abort, transport selection, socket cleanup.
