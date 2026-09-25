import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { type Connect, createFetcher, type SocketAddress } from "./mod.ts";

/** Isomorphic encode, so test strings can carry arbitrary bytes. */
function bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/** Serves a canned response over an in-memory socket, recording the request and socket state. */
function fakeServer(
  response: string | ReadableStream<Uint8Array>,
  { byteByByte = false } = {},
) {
  const written: number[] = [];
  const state = {
    closed: false,
    address: undefined as SocketAddress | undefined,
    connections: 0,
  };
  const connect: Connect = (address) => {
    state.address = address;
    state.connections++;
    const encoded = typeof response === "string" ? bytes(response) : undefined;
    return {
      readable: encoded === undefined
        ? response as ReadableStream<Uint8Array>
        : ReadableStream.from(
          byteByByte
            ? [...encoded].map((byte) => new Uint8Array([byte]))
            : [encoded],
        ),
      writable: new WritableStream({
        write: (chunk) => void written.push(...chunk),
      }),
      close: () => void (state.closed = true),
    };
  };
  const fetch = createFetcher({ connect, connectTls: connect });
  const request = () => String.fromCharCode(...written);
  return { fetch, request, state };
}

/** A readable that emits `head` and then stays open. */
function hangingAfter(head: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start: (controller) => controller.enqueue(bytes(head)),
  });
}

Deno.test("serializes the request with framing headers", async () => {
  const server = fakeServer("HTTP/1.1 204 No Content\r\n\r\n");
  await server.fetch("http://example.com:8080/a/b?x=1#frag", {
    method: "POST",
    headers: {
      "X-Custom": "é",
      Connection: "keep-alive",
      "Content-Length": "999",
    },
    body: "hello",
  });
  assertEquals(
    server.request(),
    "POST /a/b?x=1 HTTP/1.1\r\n" +
      "host: example.com:8080\r\n" +
      "accept: */*\r\n" +
      "connection: keep-alive\r\n" +
      "content-type: text/plain;charset=UTF-8\r\n" +
      "x-custom: é\r\n" +
      "content-length: 5\r\n" +
      "\r\n" +
      "hello",
  );
  assertEquals(server.state.address, { hostname: "example.com", port: 8080 });
});

Deno.test("keeps a user-supplied Host and Accept", async () => {
  const server = fakeServer("HTTP/1.1 204 No Content\r\n\r\n");
  await server.fetch("http://[::1]/", {
    headers: { Host: "other.test", Accept: "text/html" },
  });
  assertEquals(
    server.request(),
    "GET / HTTP/1.1\r\nhost: other.test\r\naccept: text/html\r\nconnection: close\r\n\r\n",
  );
  assertEquals(server.state.address, { hostname: "::1", port: 80 });
});

Deno.test("sends Content-Length: 0 for bodiless POST", async () => {
  const server = fakeServer("HTTP/1.1 204 No Content\r\n\r\n");
  await server.fetch("https://example.com/", { method: "POST" });
  assert(server.request().includes("\r\ncontent-length: 0\r\n"));
  assertEquals(server.state.address?.port, 443);
});

Deno.test("decodes a chunked body split across every byte", async () => {
  const server = fakeServer(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "5;ext=1\r\nhello\r\n1 ; a\r\n \r\n5\r\nworld\r\n0\r\nTrailer: x\r\n\r\n",
    { byteByByte: true },
  );
  const response = await server.fetch("http://example.com/");
  assertEquals(response.status, 200);
  assertEquals(response.statusText, "OK");
  assertEquals(await response.text(), "hello world");
  assert(server.state.closed);
});

Deno.test("reads a Content-Length body and ignores trailing bytes", async () => {
  const server = fakeServer(
    "HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\nhello extra",
  );
  const response = await server.fetch("http://example.com/");
  assertEquals(await response.text(), "hello");
  assert(server.state.closed);
});

Deno.test("reads a close-delimited body", async () => {
  const server = fakeServer("HTTP/1.1 200 OK\r\n\r\nuntil close", {
    byteByByte: true,
  });
  assertEquals(
    await (await server.fetch("http://example.com/")).text(),
    "until close",
  );
  assert(server.state.closed);
});

Deno.test("returns a null body for HEAD, 204, and 304", async () => {
  const cases: [string, string][] = [
    ["HEAD", "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n"],
    ["GET", "HTTP/1.1 204 No Content\r\nContent-Length: 10\r\n\r\n"],
    ["GET", "HTTP/1.1 304 Not Modified\r\nTransfer-Encoding: chunked\r\n\r\n"],
  ];
  for (const [method, response] of cases) {
    const server = fakeServer(response);
    const result = await server.fetch("http://example.com/", { method });
    assertStrictEquals(result.body, null);
    assert(server.state.closed);
  }
});

Deno.test("skips interim 1xx responses", async () => {
  const server = fakeServer(
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n" +
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
  );
  const response = await server.fetch("http://example.com/");
  assertEquals(response.headers.get("link"), null);
  assertEquals(await response.text(), "ok");
});

Deno.test("parses headers leniently where RFC 9112 allows", async () => {
  const server = fakeServer(
    "HTTP/1.1 200\nX-Folded: a \r\n \t b\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nX-Byte: \xe9\x80\r\nContent-Length: 0\n\n",
  );
  const response = await server.fetch("http://example.com/");
  assertEquals(response.statusText, "");
  assertEquals(response.headers.get("x-folded"), "a b");
  assertEquals(response.headers.getSetCookie(), ["a=1", "b=2"]);
  assertEquals(response.headers.get("x-byte"), "\xe9\x80");
});

Deno.test("rejects malformed responses with TypeError", async (t) => {
  const cases: Record<string, string> = {
    "empty response": "",
    "invalid status line": "HTTP/2 200 OK\r\n\r\n",
    "status out of range": "HTTP/1.1 600 Nope\r\n\r\n",
    "101 without upgrade": "HTTP/1.1 101 Switching Protocols\r\n\r\n",
    "whitespace before first header": "HTTP/1.1 200 OK\r\n X: y\r\n\r\n",
    "whitespace before colon": "HTTP/1.1 200 OK\r\nX : y\r\n\r\n",
    "missing colon": "HTTP/1.1 200 OK\r\nX\r\n\r\n",
    "bare CR in value": "HTTP/1.1 200 OK\r\nX: a\rb\r\n\r\n",
    "NUL in value": "HTTP/1.1 200 OK\r\nX: a\0b\r\n\r\n",
    "header section too large": `HTTP/1.1 200 OK\r\nX: ${
      "a".repeat(64 * 1024)
    }\r\n\r\n`,
    "truncated head": "HTTP/1.1 200 OK\r\nX: y\r\n",
    "Transfer-Encoding with Content-Length":
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n",
    "unsupported Transfer-Encoding":
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
    "Transfer-Encoding in HTTP/1.0":
      "HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
    "invalid Content-Length": "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n",
    "conflicting Content-Length":
      "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n",
  };
  for (const [name, response] of Object.entries(cases)) {
    await t.step(name, async () => {
      const server = fakeServer(response);
      await assertRejects(
        () => server.fetch("http://example.com/"),
        TypeError,
        "fetch failed",
      );
      assert(server.state.closed);
    });
  }
});

Deno.test("errors the body stream on malformed or truncated bodies", async (t) => {
  const cases: Record<string, string> = {
    "truncated Content-Length":
      "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort",
    "truncated chunked":
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel",
    "missing chunk terminator":
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhixx\r\n0\r\n\r\n",
    "invalid chunk size":
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
    "missing last chunk":
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n",
  };
  for (const [name, response] of Object.entries(cases)) {
    await t.step(name, async () => {
      const server = fakeServer(response);
      const result = await server.fetch("http://example.com/");
      await assertRejects(() => result.text(), TypeError, "fetch failed");
      assert(server.state.closed);
    });
  }
});

Deno.test("closes the socket when the body is cancelled", async () => {
  const server = fakeServer(hangingAfter("HTTP/1.1 200 OK\r\n\r\npartial"));
  const response = await server.fetch("http://example.com/");
  await response.body!.cancel();
  assert(server.state.closed);
});

Deno.test("aborts before connecting", async () => {
  const server = fakeServer("HTTP/1.1 200 OK\r\n\r\n");
  const reason = new Error("stop");
  await assertRejects(
    () =>
      server.fetch("http://example.com/", {
        signal: AbortSignal.abort(reason),
      }),
    Error,
    "stop",
  );
  assertEquals(server.state.connections, 0);
});

Deno.test("aborts while connecting", async () => {
  const controller = new AbortController();
  let closed = false;
  let resolveSocket!: (socket: Awaited<ReturnType<Connect>>) => void;
  const connect: Connect = () =>
    new Promise((resolve) => (resolveSocket = resolve));
  const fetch = createFetcher({ connect, connectTls: connect });
  const pending = fetch("http://example.com/", { signal: controller.signal });
  controller.abort(new Error("stop"));
  await assertRejects(() => pending, Error, "stop");
  resolveSocket({
    readable: new ReadableStream(),
    writable: new WritableStream(),
    close: () => void (closed = true),
  });
  await new Promise((resolve) => setTimeout(resolve));
  assert(closed);
});

Deno.test("aborts while waiting for the response head", async () => {
  const controller = new AbortController();
  const server = fakeServer(hangingAfter("HTTP/1.1 200 OK\r\n"));
  const pending = server.fetch("http://example.com/", {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve));
  controller.abort(new Error("stop"));
  await assertRejects(() => pending, Error, "stop");
  assert(server.state.closed);
});

Deno.test("aborts while reading the body", async () => {
  const controller = new AbortController();
  const server = fakeServer(
    hangingAfter("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhello"),
  );
  const response = await server.fetch("http://example.com/", {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  assertEquals(new TextDecoder().decode((await reader.read()).value), "hello");
  const next = reader.read();
  controller.abort(new Error("stop"));
  await assertRejects(() => next, Error, "stop");
  assert(server.state.closed);
});

Deno.test("sets the response URL without the fragment", async () => {
  const server = fakeServer("HTTP/1.1 204 No Content\r\n\r\n");
  const response = await server.fetch("http://example.com/path?q#frag");
  assertEquals(response.url, "http://example.com/path?q");
  assertEquals(response.redirected, false);
});

Deno.test("rejects unsupported protocols", async () => {
  const server = fakeServer("");
  await assertRejects(
    () => server.fetch("ftp://example.com/"),
    TypeError,
    "Unsupported protocol",
  );
  assertEquals(server.state.connections, 0);
});
