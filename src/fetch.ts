import type { Connect, FetcherOptions, Socket, SocketAddress } from "../mod.ts";
import { BufferedReader } from "./buffered_reader.ts";
import {
  type BodySource,
  bodySource,
  readResponseHead,
  serializeRequest,
} from "./http1.ts";

export async function send(
  options: FetcherOptions,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  request.signal.throwIfAborted();
  const url = new URL(request.url);
  const connect = url.protocol === "http:"
    ? options.connect
    : url.protocol === "https:"
    ? options.connectTls
    : undefined;
  if (connect === undefined) {
    throw new TypeError(`Unsupported protocol: ${url.protocol}`);
  }
  const body = request.body === null
    ? null
    : new Uint8Array(await request.arrayBuffer());
  const message = serializeRequest(request, url, body);

  const connection = new Connection(request.signal);
  try {
    const socket = await connection.open(connect, toAddress(url));
    await connection.run(write(socket, message));
    const reader = new BufferedReader(socket.readable);
    const head = await connection.run(readResponseHead(reader));
    const source = bodySource(reader, head, request.method);
    const stream = source === null ? null : connection.stream(source);
    if (stream === null) await connection.close();
    const response = new Response(stream, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
    });
    url.hash = "";
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  } catch (error) {
    await connection.close();
    throw connection.toFetchError(error);
  }
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
