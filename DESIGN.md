# Design

## Goal

A `fetch`-compatible HTTP/1.1 client built on a user-supplied socket API. Published on JSR, written for Deno, and must run on Cloudflare Workers (workerd).

## Principles

- Compatibility target is the behavior Deno, workerd, and Node's `fetch` share. The specs below are the reference for details, but compliance is a trade-off: follow them where it stays simple, and settle on the common runtime behavior where full compliance would add real complexity.
- Skip spec steps whose effect cannot be observed through this library's API.

## Interface

`createFetcher({ connect, connectTls })` returns `typeof fetch`.

- `connect` is used for `http:` URLs, `connectTls` for `https:`. The library never implements TLS.
- `Connect` is `(address: SocketAddress) => Socket | Promise<Socket>`. `Deno.connect`/`Deno.connectTls` and `cloudflare:sockets` `connect` satisfy it directly.
- The core module must not reference `Deno` or `cloudflare:*`.
- Customization (address overrides, CA certificates, proxies, logging) is done by wrapping `connect`/`connectTls`, not by fetcher options.

## Scope

- HTTP/1.1 only. `connectTls` must not negotiate another protocol via ALPN.
- No connection pooling: one connection per request, closed after the response. Workers sockets cannot be shared across requests.
- No `Upgrade` support.
- Browser-only fetch concerns (CORS, CSP, cookie jar, HTTP cache) are out of scope.

## Specifications

- [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112) HTTP/1.1: message syntax, body length (§6.3), chunked coding (§7.1), connection management and smuggling (§11).
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) HTTP Semantics: methods, status codes, bodiless responses, redirects, content coding, field syntax (§5).
- [WHATWG Fetch](https://fetch.spec.whatwg.org/): `fetch()` behavior, including redirect handling, abort, body extraction, and `Response` fields.
- [WHATWG URL](https://url.spec.whatwg.org/): provided by the runtime's `URL`.

## References

All permissively licensed. Retain copyright notices for any logic borrowed.

- [h11](https://github.com/python-hyper/h11) (MIT): sans-I/O HTTP/1.1, primary model for the protocol layer.
- [undici](https://github.com/nodejs/undici) (MIT): `lib/web/fetch/index.js` for Fetch algorithm steps, `lib/dispatcher/client-h1.js` for the HTTP/1.1 client.
- [llhttp](https://github.com/nodejs/llhttp) (MIT): strict parser and its lenient-mode flags.
- [Go net/http](https://github.com/golang/go/tree/master/src/net/http) (BSD-3): `transport.go`, `internal/chunked.go`.
- [httparse](https://github.com/seanmonstar/httparse) (MIT/Apache-2.0): header tokenizing.
- [web-platform-tests `fetch/`](https://github.com/web-platform-tests/wpt/tree/master/fetch) (BSD-3): conformance tests.

Do not read or port code from copyleft projects (e.g. `shadowfetch`, AGPL-3.0).

## Runtime built-ins

Rely on built-ins available in both Deno and workerd instead of reimplementing:

- `URL`: parsing, default ports, request target, redirect `Location` resolution.
- `Request`: normalizing `fetch` arguments, method normalization, body extraction and `Content-Type` (including multipart `FormData`).
- `Headers`: name/value validation, `getSetCookie()`.
- `Response`: status validation, null-body status checks.
- `TextEncoder`/`TextDecoder` for body text only.
- `DecompressionStream`.
- Web streams and `AbortSignal` (`AbortSignal.any`).

Runtime differences and constraints (verified on Deno 2.9.7 and workerd 2026-08-18):

- workerd's `DecompressionStream` supports only `gzip`, `deflate`, `deflate-raw`. Only advertise and decode `gzip` and `deflate`.
- `Response` only accepts status 200–599 (Deno also allows 101). Consume 1xx interim responses; treat other out-of-range statuses as a network error.
- Neither runtime's `Headers` enforces forbidden request headers, so header policy is ours to define.
- `Response.url` and `Response.redirected` cannot be set via the constructor; define them on the instance with `Object.defineProperty`. The native `clone()` drops them, while native `fetch` responses keep them on clones in all three runtimes, so `clone()` is wrapped.
- `TextDecoder("latin1")` is windows-1252 per the Encoding Standard (`0x80` decodes to `€`). Header bytes need isomorphic decoding (byte to code unit), and isomorphic encoding on the way out.
- Deno's `Headers` returns `""` instead of throwing for a value with surrounding whitespace and an interior CR or LF (reported upstream). The parser rejects CR and NUL in the response head itself.
- Deno closes a socket once its readable side ends, so a later `close()` throws. Socket cleanup ignores `close()` errors.
- For `redirect: "manual"`, Deno, workerd, and Node return the actual 3xx response rather than the spec's opaque-redirect response.

## Behavior

Request:

- `new Request(input, init)` normalizes arguments.
- A `ReadableStream` `init.body` is sent with chunked coding (as all three runtimes do), piped with the abort signal so an abort cancels it. The request is fully sent before the response is read (`duplex: "half"`). Other bodies, including a stream carried by an input `Request`, are buffered and sent with `Content-Length` (`0` for bodiless `POST`/`PUT`).
- Request target is path plus query. `host` is sent first; a user-supplied `Host` is kept.
- `Accept: */*` is added if absent. No default `User-Agent` (workerd sends none).
- `Accept-Encoding: gzip, deflate` is added if absent (as Node does; Deno sends `gzip,br`, workerd none), or `identity` when a `Range` header is present.
- `Connection: close` is added unless the user set `Connection`. User `Content-Length` and `Transfer-Encoding` are replaced, since framing is ours (Deno and workerd also ignore a user `Content-Length` on stream bodies).

Response:

- Status line and fields are parsed as bytes with a 64 KiB head limit. LF-only line endings are accepted, obs-fold is replaced with SP, whitespace before the first field and CR/NUL in fields are rejected.
- Interim 1xx responses are skipped; 101 and statuses outside 100–599 are errors.
- Body length per RFC 9112 §6.3: none for `HEAD`, 204, and 304; chunked (extensions ignored, trailers discarded); `Content-Length` (identical duplicates accepted); otherwise until close. `Transfer-Encoding` with `Content-Length`, any coding other than a single `chunked`, and `Transfer-Encoding` in HTTP/1.0 are errors.
- The body is a pull-based stream. The socket closes when the body completes, errors, or is cancelled, or immediately when there is no body.
- `Content-Encoding` `gzip`, `x-gzip`, and `deflate` are decoded with `DecompressionStream`, last applied first, regardless of what was requested (as all three runtimes do). A body with any other coding is passed through unchanged. Headers are kept as received.
- `url` (without fragment), `redirected`, and `headers` are defined on the `Response` instance, and `clone()` is overridden to carry them over. `headers` is a `Headers` subclass whose `set`, `append`, and `delete` throw `TypeError`, matching the immutable headers of fetched responses in all three runtimes.

Redirects (Fetch HTTP-redirect fetch):

- `follow`, `manual` (returns the 3xx), and `error` (rejects on any redirect status).
- A 3xx without `Location` is returned as-is. An unparseable or non-HTTP(S) `Location`, or a 21st redirect, is a network error.
- 301/302 turn `POST` into `GET`; 303 turns anything but `GET`/`HEAD` into `GET`. Both drop the body and the request-body headers.
- A stream `init.body` is not replayed except on 303. A stream body carried by an input `Request` is not detectable and is replayed from the buffer.
- A cross-origin hop removes `Authorization` and a user-supplied `Host`, and they stay removed.
- Fragment inheritance from the request URL is skipped (not observable).

Errors and abort:

- Network and protocol errors reject with `TypeError("fetch failed")`, with the underlying error as `cause`. A body stream errors the same way.
- `init.signal` rejects with its reason before connecting, while connecting, while waiting for the head, and while reading the body, and closes the socket.

## Known differences

From runtime `fetch`: `response.type` is `"default"`, as in workerd; Deno reports `"basic"` and Node `"basic"` or `"cors"`, so there is no common value. `response.headers` is an instance of a `Headers` subclass.

## Testing

- `deno task test`: unit tests through `createFetcher` with an in-memory fake socket, plus example.com end-to-end tests compared against native `fetch`. Deno's resource sanitizer catches leaked sockets.
- `deno task test:workerd`: bundles `test/workerd/worker.ts` and runs the example.com checks under local workerd.
- example.com is behind Cloudflare, which blocks `connect()` from deployed Workers, so it can only be tested on local workerd.
