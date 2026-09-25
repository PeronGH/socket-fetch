const LF = 0x0a;
const CR = 0x0d;

/** Reads lines and bounded chunks from a byte stream, keeping unread bytes buffered. */
export class BufferedReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Returns up to `max` bytes, or `null` at end of stream. */
  async read(max: number): Promise<Uint8Array | null> {
    while (this.#buffer.length === 0) {
      const { done, value } = await this.#reader.read();
      if (done) return null;
      this.#buffer = value;
    }
    const chunk = this.#buffer.subarray(0, max);
    this.#buffer = this.#buffer.subarray(chunk.length);
    return chunk;
  }

  /**
   * Returns the next line without its LF or CRLF terminator, or `null` if the stream ends before any byte.
   * Throws if the line exceeds `limit` bytes or the stream ends mid-line.
   */
  async readLine(limit: number): Promise<Uint8Array | null> {
    let searchFrom = 0;
    while (true) {
      const lf = this.#buffer.indexOf(LF, searchFrom);
      if (lf !== -1) {
        const end = lf > 0 && this.#buffer[lf - 1] === CR ? lf - 1 : lf;
        if (end > limit) throw new Error("Line too long");
        const line = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(lf + 1);
        return line;
      }
      if (this.#buffer.length > limit + 1) throw new Error("Line too long");
      searchFrom = this.#buffer.length;
      const { done, value } = await this.#reader.read();
      if (done) {
        if (this.#buffer.length === 0) return null;
        throw new Error("Connection closed mid-line");
      }
      this.#buffer = concat(this.#buffer, value);
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
