import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { type Connect, createFetcher, type SocketAddress } from "./mod.ts";

/** Isomorphic encode, so test strings can carry arbitrary bytes. */
function bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

type Canned = string | ReadableStream<Uint8Array>;

/**
 * Serves one canned response per connection over in-memory sockets, recording requests and
 * socket state. `closed` is true once every opened socket has been closed.
 */
function fakeServer(
  responses: Canned | Canned[],
  { byteByByte = false } = {},
) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const written: number[][] = [];
  const tls: boolean[] = [];
  let open = 0;
  const state = {
    get closed() {
      return open === 0;
    },
    address: undefined as SocketAddress | undefined,
    connections: 0,
  };
  const connector = (secure: boolean): Connect => (address) => {
    const response = queue.shift();
    if (response === undefined) throw new Error("No response left");
    state.address = address;
    state.connections++;
    tls.push(secure);
    open++;
    const chunks: number[] = [];
    written.push(chunks);
    let closed = false;
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
        write: (chunk) => void chunks.push(...chunk),
      }),
      close: () => {
        if (!closed) open--;
        closed = true;
      },
    };
  };
  const fetch = createFetcher({
    connect: connector(false),
    connectTls: connector(true),
  });
  const requests = () =>
    written.map((chunks) => String.fromCharCode(...chunks));
  const request = () => requests().at(-1)!;
  return { fetch, request, requests, tls, state };
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
      "accept-encoding: gzip, deflate\r\n" +
      "connection: keep-alive\r\n" +
      "content-type: text/plain;charset=UTF-8\r\n" +
      "x-custom: é\r\n" +
      "content-length: 5\r\n" +
      "\r\n" +
      "hello",
  );
  assertEquals(server.state.address, { hostname: "example.com", port: 8080 });
});

Deno.test("keeps a user-supplied Host, Accept, and Accept-Encoding", async () => {
  const server = fakeServer("HTTP/1.1 204 No Content\r\n\r\n");
  await server.fetch("http://[::1]/", {
    headers: {
      Host: "other.test",
      Accept: "text/html",
      "Accept-Encoding": "br",
    },
  });
  assertEquals(
    server.request(),
    "GET / HTTP/1.1\r\nhost: other.test\r\naccept: text/html\r\naccept-encoding: br\r\nconnection: close\r\n\r\n",
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
    "fetch failed",
  );
  assertEquals(server.state.connections, 0);
});

const OK = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

function redirect(status: number, location: string): string {
  return `HTTP/1.1 ${status} Redirect\r\nLocation: ${location}\r\nContent-Length: 5\r\n\r\nmoved`;
}

Deno.test("follows every redirect status to a relative Location", async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    await t.step(String(status), async () => {
      const server = fakeServer([redirect(status, "/next?q"), OK]);
      const response = await server.fetch("http://example.com/start#frag");
      assertEquals(await response.text(), "ok");
      assertEquals(response.url, "http://example.com/next?q");
      assertEquals(response.redirected, true);
      assert(
        server.requests()[1].startsWith(
          "GET /next?q HTTP/1.1\r\nhost: example.com\r\n",
        ),
      );
      assert(server.state.closed);
    });
  }
});

Deno.test("rewrites method and body per redirect status", async (t) => {
  const cases: [number, string, string][] = [
    [301, "POST", "GET"],
    [302, "POST", "GET"],
    [303, "POST", "GET"],
    [303, "PUT", "GET"],
    [303, "HEAD", "HEAD"],
    [302, "PUT", "PUT"],
    [307, "POST", "POST"],
    [308, "PUT", "PUT"],
  ];
  for (const [status, method, expected] of cases) {
    await t.step(`${status} ${method} -> ${expected}`, async () => {
      const server = fakeServer([redirect(status, "/next"), OK]);
      const hasBody = method !== "HEAD";
      await server.fetch("http://example.com/", {
        method,
        headers: { "Content-Language": "en", "X-Other": "1" },
        body: hasBody ? "data" : undefined,
      });
      const second = server.requests()[1];
      assert(second.startsWith(`${expected} /next HTTP/1.1\r\n`));
      assert(second.includes("\r\nx-other: 1\r\n"));
      const rewritten = method !== expected;
      assertEquals(second.includes("content-language: en"), !rewritten);
      assertEquals(
        second.includes("content-type: text/plain"),
        hasBody && !rewritten,
      );
      assertEquals(second.endsWith("\r\n\r\ndata"), hasBody && !rewritten);
    });
  }
});

Deno.test("drops Authorization and Host once a redirect changes origin", async () => {
  const server = fakeServer([
    redirect(302, "/same"),
    redirect(302, "https://other.test/"),
    redirect(302, "http://example.com/back"),
    OK,
  ]);
  const response = await server.fetch("http://example.com/", {
    headers: { Authorization: "secret", Host: "custom" },
  });
  assertEquals(response.url, "http://example.com/back");
  const [, same, other, back] = server.requests();
  assert(same.includes("\r\nauthorization: secret\r\n"));
  assert(same.includes("\r\nhost: custom\r\n"));
  assert(!other.includes("authorization"));
  assert(other.includes("\r\nhost: other.test\r\n"));
  assert(!back.includes("authorization"));
  assertEquals(server.tls, [false, false, true, false]);
});

Deno.test("returns a redirect without Location as-is", async () => {
  const server = fakeServer("HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n");
  const response = await server.fetch("http://example.com/");
  assertEquals(response.status, 302);
  assertEquals(response.redirected, false);
  assertEquals(server.state.connections, 1);
});

Deno.test("returns the redirect response in manual mode", async () => {
  const server = fakeServer(redirect(301, "/next"));
  const response = await server.fetch("http://example.com/", {
    redirect: "manual",
  });
  assertEquals(response.status, 301);
  assertEquals(response.headers.get("location"), "/next");
  assertEquals(response.redirected, false);
  assertEquals(await response.text(), "moved");
  assert(server.state.closed);
});

Deno.test("rejects any redirect status in error mode", async () => {
  for (
    const response of [
      redirect(301, "/next"),
      "HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n",
    ]
  ) {
    const server = fakeServer(response);
    await assertRejects(
      () => server.fetch("http://example.com/", { redirect: "error" }),
      TypeError,
      "fetch failed",
    );
    assert(server.state.closed);
  }
});

Deno.test("rejects invalid and non-HTTP(S) Locations", async () => {
  for (const location of ["http://[::1", "ftp://example.com/", "data:,x"]) {
    const server = fakeServer([redirect(302, location), OK]);
    await assertRejects(
      () => server.fetch("http://example.com/"),
      TypeError,
      "fetch failed",
    );
    assertEquals(server.state.connections, 1);
    assert(server.state.closed);
  }
});

Deno.test("follows at most 20 redirects", async () => {
  const hops = (count: number) =>
    Array.from({ length: count }, (_, i) => redirect(302, `/${i}`));

  const ok = fakeServer([...hops(20), OK]);
  assertEquals(await (await ok.fetch("http://example.com/")).text(), "ok");

  const tooMany = fakeServer([...hops(21), OK]);
  await assertRejects(
    () => tooMany.fetch("http://example.com/"),
    TypeError,
    "fetch failed",
  );
  assertEquals(tooMany.state.connections, 21);
  assert(tooMany.state.closed);
});

Deno.test("does not replay a stream body except on 303", async () => {
  const streamed = () => ({
    method: "POST",
    body: ReadableStream.from([bytes("data")]),
    duplex: "half",
  } as RequestInit);

  const replay = fakeServer([redirect(307, "/next"), OK]);
  await assertRejects(
    () => replay.fetch("http://example.com/", streamed()),
    TypeError,
    "fetch failed",
  );
  assertEquals(replay.state.connections, 1);

  const seeOther = fakeServer([redirect(303, "/next"), OK]);
  await seeOther.fetch("http://example.com/", streamed());
  assert(seeOther.requests()[1].startsWith("GET /next HTTP/1.1\r\n"));
});

async function compress(text: string, formats: CompressionFormat[]) {
  let stream = ReadableStream.from([new TextEncoder().encode(text)]);
  for (const format of formats) {
    stream = stream.pipeThrough(new CompressionStream(format));
  }
  return String.fromCharCode(
    ...await Array.fromAsync(stream, (c) => [...c]).then((c) => c.flat()),
  );
}

function encoded(contentEncoding: string, body: string): string {
  return `HTTP/1.1 200 OK\r\nContent-Encoding: ${contentEncoding}\r\nTransfer-Encoding: chunked\r\n\r\n` +
    `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
}

Deno.test("asks for identity encoding on range requests", async () => {
  const server = fakeServer("HTTP/1.1 204 No Content\r\n\r\n");
  await server.fetch("http://example.com/", {
    headers: { Range: "bytes=0-1" },
  });
  assert(server.request().includes("\r\naccept-encoding: identity\r\n"));
});

Deno.test("decodes content codings, last applied first", async (t) => {
  const cases: [string, CompressionFormat[]][] = [
    ["gzip", ["gzip"]],
    ["X-Gzip", ["gzip"]],
    ["deflate", ["deflate"]],
    ["deflate", ["deflate-raw"]],
    ["deflate, gzip", ["deflate", "gzip"]],
  ];
  for (const [contentEncoding, formats] of cases) {
    await t.step(`${contentEncoding} (${formats.join(", ")})`, async () => {
      const server = fakeServer(
        encoded(contentEncoding, await compress("hello", formats)),
        { byteByByte: true },
      );
      const response = await server.fetch("http://example.com/");
      assertEquals(await response.text(), "hello");
      assertEquals(response.headers.get("content-encoding"), contentEncoding);
      assert(server.state.closed);
    });
  }
});

Deno.test("passes through codings it cannot decode", async () => {
  const server = fakeServer(encoded("gzip, br", "raw"));
  assertEquals(await (await server.fetch("http://example.com/")).text(), "raw");
});

Deno.test("errors the body and closes the socket on corrupt content", async (t) => {
  for (const coding of ["gzip", "deflate"]) {
    await t.step(coding, async () => {
      const server = fakeServer(encoded(coding, "not compressed"));
      const response = await server.fetch("http://example.com/");
      await assertRejects(() => response.text(), TypeError);
      assert(server.state.closed);
    });
  }
});

Deno.test("keeps url and redirected on clones", async () => {
  const server = fakeServer([redirect(302, "/next"), OK]);
  const response = await server.fetch("http://example.com/");
  const clone = response.clone().clone();
  assertEquals([clone.url, clone.redirected], [
    "http://example.com/next",
    true,
  ]);
  assertEquals(await clone.text(), "ok");
  assertEquals(await response.text(), "ok");
  assert(server.state.closed);
});

function streamedPost(body: ReadableStream<Uint8Array>): RequestInit {
  return { method: "POST", body, duplex: "half" } as RequestInit;
}

Deno.test("streams a ReadableStream body with chunked coding", async () => {
  const server = fakeServer("HTTP/1.1 204 No Content\r\n\r\n");
  await server.fetch("http://example.com/", {
    ...streamedPost(
      ReadableStream.from([bytes("hel"), new Uint8Array(0), bytes("lo")]),
    ),
    headers: { "Content-Length": "99" },
  });
  const [head] = server.request().split("\r\n\r\n", 1);
  assert(head.includes("\r\ntransfer-encoding: chunked"));
  assert(!head.includes("content-length"));
  assertEquals(
    server.request().slice(head.length + 4),
    "3\r\nhel\r\n2\r\nlo\r\n0\r\n\r\n",
  );
});

Deno.test("rejects when the request body stream fails", async (t) => {
  const bodies: Record<string, () => ReadableStream<Uint8Array>> = {
    "stream error": () =>
      new ReadableStream({
        start: (controller) => {
          controller.enqueue(bytes("a"));
          controller.error(new Error("boom"));
        },
      }),
    "non-Uint8Array chunk": () =>
      ReadableStream.from(["text"]) as unknown as ReadableStream<Uint8Array>,
  };
  for (const [name, body] of Object.entries(bodies)) {
    await t.step(name, async () => {
      const server = fakeServer("HTTP/1.1 204 No Content\r\n\r\n");
      await assertRejects(
        () => server.fetch("http://example.com/", streamedPost(body())),
        TypeError,
        "fetch failed",
      );
      assert(server.state.closed);
    });
  }
});

Deno.test("aborts while uploading and cancels the body stream", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (stream) => stream.enqueue(bytes("a")),
    cancel: () => void (cancelled = true),
  });
  const server = fakeServer(hangingAfter(""));
  const pending = server.fetch("http://example.com/", {
    ...streamedPost(body),
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve));
  controller.abort(new Error("stop"));
  await assertRejects(() => pending, Error, "stop");
  assert(server.state.closed);
  await new Promise((resolve) => setTimeout(resolve));
  assert(cancelled);
});

Deno.test("exposes immutable response headers, also on clones", async () => {
  const server = fakeServer(
    "HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nX-A: 1\r\nContent-Length: 2\r\n\r\nok",
  );
  const response = await server.fetch("http://example.com/");
  for (const headers of [response.headers, response.clone().headers]) {
    assertEquals(headers.get("x-a"), "1");
    assertEquals(headers.getSetCookie(), ["a=1", "b=2"]);
    assert(headers instanceof Headers);
    assertThrows(() => headers.set("x-a", "2"), TypeError);
    assertThrows(() => headers.append("x-b", "2"), TypeError);
    assertThrows(() => headers.delete("x-a"), TypeError);
  }
  const copy = new Response(response.body, response);
  copy.headers.set("x-a", "2");
  assertEquals(await copy.text(), "ok");
});
