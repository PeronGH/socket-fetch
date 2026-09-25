import type { Connect, FetcherOptions, Socket, SocketAddress } from "../mod.ts";
import { BufferedReader } from "./buffered_reader.ts";
import {
  type BodySource,
  bodySource,
  decodeContent,
  readResponseHead,
  serializeRequest,
} from "./http1.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
/** Request-body-header names, removed when a redirect changes the method to GET. */
const REQUEST_BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
];

interface Exchange {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array | null;
}

/** Fetch with redirect handling per the Fetch Standard's HTTP fetch and HTTP-redirect fetch. */
export async function send(
  options: FetcherOptions,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const { signal } = request;
  signal.throwIfAborted();
  // Only stream bodies lack a source and so cannot be replayed on redirect. A stream body carried by
  // an input Request is not detectable here and is replayed from the buffered copy.
  const replayable = !(init?.body instanceof ReadableStream);
  const exchange: Exchange = {
    method: request.method,
    url: new URL(request.url),
    headers: new Headers(request.headers),
    body: request.body === null
      ? null
      : new Uint8Array(await request.arrayBuffer()),
  };

  for (let redirects = 0;; redirects++) {
    const response = await exchangeOnce(options, exchange, signal);
    const { status } = response;
    if (!REDIRECT_STATUSES.has(status) || request.redirect === "manual") {
      return finish(response, exchange.url, redirects > 0);
    }
    const location = response.headers.get("location");
    if (request.redirect === "follow" && location === null) {
      return finish(response, exchange.url, redirects > 0);
    }
    await response.body?.cancel();
    if (request.redirect === "error") {
      throw networkError(`Redirect with redirect mode "error"`);
    }

    const next = URL.parse(location!, exchange.url);
    if (next === null) throw networkError(`Invalid Location: ${location}`);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw networkError(`Redirect to unsupported protocol: ${next.protocol}`);
    }
    if (redirects === MAX_REDIRECTS) throw networkError("Too many redirects");
    if (status !== 303 && exchange.body !== null && !replayable) {
      throw networkError("Cannot replay a stream body on redirect");
    }
    if (
      ((status === 301 || status === 302) && exchange.method === "POST") ||
      (status === 303 && exchange.method !== "GET" &&
        exchange.method !== "HEAD")
    ) {
      exchange.method = "GET";
      exchange.body = null;
      for (const name of REQUEST_BODY_HEADERS) exchange.headers.delete(name);
    }
    if (next.origin !== exchange.url.origin) {
      exchange.headers.delete("authorization");
      // A user-supplied Host names the original origin, so it must not follow a cross-origin redirect.
      exchange.headers.delete("host");
    }
    exchange.url = next;
  }
}

async function exchangeOnce(
  options: FetcherOptions,
  { method, url, headers, body }: Exchange,
  signal: AbortSignal,
): Promise<Response> {
  const connect = url.protocol === "http:"
    ? options.connect
    : url.protocol === "https:"
    ? options.connectTls
    : undefined;
  if (connect === undefined) {
    throw networkError(`Unsupported protocol: ${url.protocol}`);
  }
  const message = serializeRequest(method, url, headers, body);

  const connection = new Connection(signal);
  try {
    const socket = await connection.open(connect, toAddress(url));
    await connection.run(write(socket, message));
    const reader = new BufferedReader(socket.readable);
    const head = await connection.run(readResponseHead(reader));
    const source = bodySource(reader, head, method);
    const stream = source === null ? null : decodeContent(
      connection.stream(source),
      head.headers.get("content-encoding"),
    );
    if (stream === null) await connection.close();
    return new Response(stream, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
    });
  } catch (error) {
    await connection.close();
    throw connection.toFetchError(error);
  }
}

function finish(response: Response, url: URL, redirected: boolean): Response {
  const responseUrl = new URL(url);
  responseUrl.hash = "";
  Object.defineProperties(response, {
    url: { value: responseUrl.href },
    redirected: { value: redirected },
  });
  return response;
}

function networkError(message: string): TypeError {
  return new TypeError("fetch failed", { cause: new Error(message) });
}

/** Owns one socket for one exchange: aborting, closing, and mapping errors to fetch semantics. */
class Connection {
  #signal: AbortSignal;
  #aborted: Promise<never>;
  #onAbort!: () => void;
  #socket?: Socket;
  #controller?: ReadableStreamDefaultController<Uint8Array>;
  #closed = false;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
    this.#aborted = new Promise((_, reject) => {
      this.#onAbort = () => {
        reject(signal.reason);
        this.#controller?.error(signal.reason);
        this.close();
      };
    });
    this.#aborted.catch(() => {});
    signal.addEventListener("abort", this.#onAbort);
  }

  async open(connect: Connect, address: SocketAddress): Promise<Socket> {
    const pending = Promise.resolve().then(() => connect(address));
    try {
      this.#socket = await this.run(pending);
    } catch (error) {
      pending.then(closeQuietly, () => {});
      throw error;
    }
    return this.#socket;
  }

  /** Settles with `promise`, or rejects with the abort reason as soon as the signal aborts. */
  run<T>(promise: Promise<T>): Promise<T> {
    this.#signal.throwIfAborted();
    return Promise.race([promise, this.#aborted]);
  }

  stream(source: BodySource): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      pull: async (controller) => {
        try {
          const chunk = await this.run(source());
          if (chunk === null) {
            controller.close();
            await this.close();
          } else {
            controller.enqueue(chunk);
          }
        } catch (error) {
          await this.close();
          controller.error(this.toFetchError(error));
        }
      },
      cancel: () => this.close(),
    }, { highWaterMark: 0 });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#onAbort);
    if (this.#socket !== undefined) await closeQuietly(this.#socket);
  }

  toFetchError(error: unknown): unknown {
    return this.#signal.aborted
      ? this.#signal.reason
      : new TypeError("fetch failed", { cause: error });
  }
}

async function write(socket: Socket, bytes: Uint8Array): Promise<void> {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

async function closeQuietly(socket: Socket): Promise<void> {
  try {
    await socket.close();
  } catch {
    // Deno closes the socket itself once its readable side ends, so a later close() throws.
  }
}

function toAddress(url: URL): SocketAddress {
  const port = url.port === ""
    ? (url.protocol === "https:" ? 443 : 80)
    : Number(url.port);
  return { hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"), port };
}
