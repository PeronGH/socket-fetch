import type { BufferedReader } from "./buffered_reader.ts";

/** Upper bound for the status line plus header section, and separately for the trailer section. */
const MAX_HEAD_SIZE = 64 * 1024;
/** Upper bound for a single chunk-size line, including extensions. */
const MAX_CHUNK_LINE_SIZE = 4 * 1024;

const SP = 0x20;
const HTAB = 0x09;
const CR = 0x0d;
const NUL = 0x00;

const STATUS_LINE = /^HTTP\/1\.(\d) (\d{3})(?: (.*))?$/;
const CONTENT_LENGTH = /^\d+$/;
const HEX = /^[0-9a-fA-F]+$/;

/** Headers the fetcher controls because it owns message framing. */
const FRAMING_HEADERS = ["content-length", "transfer-encoding"];

export interface ResponseHead {
  minorVersion: number;
  status: number;
  statusText: string;
  headers: Headers;
}

/** A buffered body is sent with Content-Length, a stream body with chunked coding. */
export type RequestBody = Uint8Array | ReadableStream<Uint8Array> | null;

const CRLF = new Uint8Array([0x0d, 0x0a]);
/** Last chunk and empty trailer section of a chunked body. */
const LAST_CHUNK = new Uint8Array([0x30, 0x0d, 0x0a, 0x0d, 0x0a]);

/** Produces the next body chunk, or `null` once the body is complete. */
export type BodySource = () => Promise<Uint8Array | null>;

/**
 * Serializes a request head and body. `Connection: close` is added unless the user set `Connection`;
 * either way the socket is closed after one exchange.
 */
export function serializeRequest(
  method: string,
  url: URL,
  requestHeaders: Headers,
  body: RequestBody,
): Uint8Array {
  const headers = new Headers(requestHeaders);
  const host = headers.get("host") ?? url.host;
  headers.delete("host");
  for (const name of FRAMING_HEADERS) headers.delete(name);
  if (!headers.has("accept")) headers.set("accept", "*/*");
  if (!headers.has("accept-encoding")) {
    // Fetch Standard: partial content must not be content-coded, since it cannot be decoded alone.
    headers.set(
      "accept-encoding",
      headers.has("range") ? "identity" : "gzip, deflate",
    );
  }

  let head =
    `${method} ${url.pathname}${url.search} HTTP/1.1\r\nhost: ${host}\r\n`;
  for (const [name, value] of headers) head += `${name}: ${value}\r\n`;
  if (body instanceof ReadableStream) {
    head += "transfer-encoding: chunked\r\n";
  } else if (body !== null) {
    head += `content-length: ${body.length}\r\n`;
  } else if (method === "POST" || method === "PUT") {
    head += "content-length: 0\r\n";
  }
  if (!headers.has("connection")) head += "connection: close\r\n";
  head += "\r\n";

  const buffered = body instanceof Uint8Array ? body : null;
  const bytes = new Uint8Array(head.length + (buffered?.length ?? 0));
  for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
  if (buffered !== null) bytes.set(buffered, head.length);
  return bytes;
}

/** Encodes a request body stream with chunked coding, including the last chunk. */
export function chunkedEncoder(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("Request body chunks must be Uint8Array");
      }
      // A zero-size chunk would terminate the body.
      if (chunk.length === 0) return;
      const size = `${chunk.length.toString(16)}\r\n`;
      const bytes = new Uint8Array(size.length + chunk.length + 2);
      for (let i = 0; i < size.length; i++) bytes[i] = size.charCodeAt(i);
      bytes.set(chunk, size.length);
      bytes.set(CRLF, size.length + chunk.length);
      controller.enqueue(bytes);
    },
    flush(controller) {
      controller.enqueue(LAST_CHUNK);
    },
  });
}

/** Reads the final response head, skipping interim 1xx responses. */
export async function readResponseHead(
  reader: BufferedReader,
): Promise<ResponseHead> {
  while (true) {
    const head = await readHead(reader);
    if (head.status === 101) {
      throw new Error("Unexpected 101 Switching Protocols");
    }
    if (head.status >= 200) return head;
  }
}

async function readHead(reader: BufferedReader): Promise<ResponseHead> {
  let budget = MAX_HEAD_SIZE;
  const nextLine = async () => {
    const line = await reader.readLine(budget);
    if (line === null) {
      throw new Error("Connection closed before response head");
    }
    // RFC 9110 §5.5: CR and NUL are invalid in fields. Checked here because Deno's
    // Headers accepts them after leading whitespace.
    if (line.includes(CR) || line.includes(NUL)) {
      throw new Error("CR or NUL in response head");
    }
    budget -= line.length + 2;
    return line;
  };

  const statusLine = decode(await nextLine());
  const match = STATUS_LINE.exec(statusLine);
  if (match === null) {
    throw new Error(`Invalid status line: ${JSON.stringify(statusLine)}`);
  }
  const status = Number(match[2]);
  if (status < 100 || status > 599) {
    throw new Error(`Status code out of range: ${status}`);
  }

  const fields: [string, string][] = [];
  while (true) {
    const line = await nextLine();
    if (line.length === 0) break;
    if (line[0] === SP || line[0] === HTAB) {
      // RFC 9112 §5.2: a user agent must replace obs-fold with SP.
      const last = fields.at(-1);
      if (last === undefined) {
        throw new Error("Whitespace before first header field");
      }
      last[1] = `${trimOws(last[1])} ${trimOws(decode(line))}`;
      continue;
    }
    const text = decode(line);
    const colon = text.indexOf(":");
    if (colon <= 0) {
      throw new Error(`Invalid header field: ${JSON.stringify(text)}`);
    }
    fields.push([text.slice(0, colon), text.slice(colon + 1)]);
  }

  // Headers rejects invalid names (including whitespace before the colon) and values with CR, LF, or NUL.
  const headers = new Headers();
  for (const [name, value] of fields) headers.append(name, value);

  return {
    minorVersion: Number(match[1]),
    status,
    statusText: match[3] ?? "",
    headers,
  };
}

/** Determines response framing per RFC 9112 §6.3. Returns `null` when the response has no body. */
export function bodySource(
  reader: BufferedReader,
  head: ResponseHead,
  method: string,
): BodySource | null {
  if (method === "HEAD" || head.status === 204 || head.status === 304) {
    return null;
  }

  const transferEncoding = head.headers.get("transfer-encoding");
  if (transferEncoding !== null) {
    if (head.minorVersion === 0) {
      throw new Error("Transfer-Encoding in HTTP/1.0 response");
    }
    if (head.headers.has("content-length")) {
      throw new Error("Both Transfer-Encoding and Content-Length present");
    }
    const codings = parseList(transferEncoding).map((coding) =>
      coding.toLowerCase()
    );
    if (codings.length !== 1 || codings[0] !== "chunked") {
      throw new Error(`Unsupported Transfer-Encoding: ${transferEncoding}`);
    }
    return chunkedSource(reader);
  }

  const contentLength = head.headers.get("content-length");
  if (contentLength !== null) {
    return lengthSource(reader, parseContentLength(contentLength));
  }

  return () => reader.read(Infinity);
}

function parseContentLength(value: string): number {
  const values = new Set(parseList(value));
  const [length] = values;
  if (values.size !== 1 || !CONTENT_LENGTH.test(length)) {
    throw new Error(`Invalid Content-Length: ${value}`);
  }
  const parsed = Number(length);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Content-Length too large: ${value}`);
  }
  return parsed;
}

function lengthSource(reader: BufferedReader, length: number): BodySource {
  let remaining = length;
  return async () => {
    if (remaining === 0) return null;
    const chunk = await reader.read(remaining);
    if (chunk === null) throw new Error("Connection closed before end of body");
    remaining -= chunk.length;
    return chunk;
  };
}

function chunkedSource(reader: BufferedReader): BodySource {
  let remaining = 0;
  let done = false;
  return async () => {
    if (done) return null;
    if (remaining === 0) {
      remaining = await readChunkSize(reader);
      if (remaining === 0) {
        await skipTrailers(reader);
        done = true;
        return null;
      }
    }
    const chunk = await reader.read(remaining);
    if (chunk === null) {
      throw new Error("Connection closed before end of chunked body");
    }
    remaining -= chunk.length;
    if (remaining === 0 && (await reader.readLine(0)) === null) {
      throw new Error("Connection closed before end of chunked body");
    }
    return chunk;
  };
}

async function readChunkSize(reader: BufferedReader): Promise<number> {
  const line = await reader.readLine(MAX_CHUNK_LINE_SIZE);
  if (line === null) {
    throw new Error("Connection closed before end of chunked body");
  }
  const text = decode(line);
  const semicolon = text.indexOf(";");
  // Chunk extensions are ignored (RFC 9112 §7.1.1); BWS may precede the semicolon.
  const size = (semicolon === -1 ? text : text.slice(0, semicolon)).replace(
    /[ \t]+$/,
    "",
  );
  if (!HEX.test(size)) {
    throw new Error(`Invalid chunk size: ${JSON.stringify(text)}`);
  }
  const parsed = parseInt(size, 16);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Chunk size too large: ${size}`);
  }
  return parsed;
}

async function skipTrailers(reader: BufferedReader): Promise<void> {
  let budget = MAX_HEAD_SIZE;
  while (true) {
    const line = await reader.readLine(budget);
    if (line === null) {
      throw new Error("Connection closed before end of trailers");
    }
    if (line.length === 0) return;
    budget -= line.length + 2;
  }
}

const DECOMPRESSION_FORMATS = new Map<string, CompressionFormat>([
  ["gzip", "gzip"],
  ["x-gzip", "gzip"],
  ["deflate", "deflate"],
]);

/**
 * Removes the content codings listed in `Content-Encoding`, last applied first. Bodies with a
 * coding that cannot be decoded (such as `br`, unsupported by workerd) are returned unchanged.
 */
export function decodeContent(
  body: ReadableStream<Uint8Array>,
  contentEncoding: string | null,
): ReadableStream<Uint8Array> {
  if (contentEncoding === null) return body;
  const formats = parseList(contentEncoding).map((coding) =>
    DECOMPRESSION_FORMATS.get(coding.toLowerCase())
  );
  if (formats.some((format) => format === undefined)) return body;
  let decoded = body;
  for (const format of (formats as CompressionFormat[]).reverse()) {
    // Socket chunks are typed ArrayBufferLike-backed, which DecompressionStream's types exclude.
    const decompression = new DecompressionStream(format) as TransformStream<
      Uint8Array,
      Uint8Array
    >;
    decoded = decoded.pipeThrough(decompression);
  }
  return decoded;
}

/** Splits a comma-separated field value, ignoring empty elements (RFC 9110 §5.6.1). */
function parseList(value: string): string[] {
  return value.split(",").map(trimOws).filter((element) => element !== "");
}

function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Isomorphic decode: each byte becomes the code unit of the same value. */
function decode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}
