/**
 * A `fetch`-compatible HTTP/1.1 client built on a runtime's socket API.
 *
 * @example Deno
 * ```ts
 * import { createFetcher } from "@pixel/socket-fetch";
 *
 * const fetch = createFetcher({
 *   connect: Deno.connect,
 *   connectTls: Deno.connectTls,
 * });
 * ```
 *
 * @example Cloudflare Workers
 * ```ts ignore
 * import { connect } from "cloudflare:sockets";
 * import { createFetcher } from "@pixel/socket-fetch";
 *
 * const fetch = createFetcher({
 *   connect,
 *   connectTls: (address) => connect(address, { secureTransport: "on" }),
 * });
 * ```
 *
 * @module
 */

import { send } from "./src/fetch.ts";

/** Remote endpoint derived from the request URL. */
export interface SocketAddress {
  hostname: string;
  port: number;
}

/** Bidirectional byte stream, as returned by `Deno.connect` or `cloudflare:sockets`. */
export interface Socket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void | Promise<void>;
}

/** Opens a socket to the given address. */
export type Connect = (address: SocketAddress) => Socket | Promise<Socket>;

/** Options for {@linkcode createFetcher}. */
export interface FetcherOptions {
  /** Opens plain TCP connections, used for `http:` URLs. */
  connect: Connect;
  /**
   * Opens TLS connections, used for `https:` URLs.
   *
   * Must not negotiate a protocol other than HTTP/1.1 via ALPN.
   */
  connectTls: Connect;
}

/** Creates a `fetch`-compatible function that sends requests over the given sockets. */
export function createFetcher(options: FetcherOptions): typeof fetch {
  return (input, init) => send(options, input, init);
}
