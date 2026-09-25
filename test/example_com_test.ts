import { assertEquals, assertStrictEquals } from "@std/assert";
import { createFetcher } from "../mod.ts";

const fetcher = createFetcher({
  connect: Deno.connect,
  connectTls: Deno.connectTls,
});

for (const origin of ["http://example.com", "https://example.com"]) {
  Deno.test(`GET ${origin}/ matches native fetch`, async () => {
    const [ours, native] = await Promise.all([
      fetcher(`${origin}/`),
      fetch(`${origin}/`),
    ]);
    assertEquals(ours.status, 200);
    assertEquals(ours.statusText, "OK");
    assertEquals(ours.url, `${origin}/`);
    assertEquals(ours.headers.get("content-type"), "text/html");
    assertEquals(await ours.text(), await native.text());
  });

  Deno.test(`HEAD ${origin}/ has no body`, async () => {
    const response = await fetcher(`${origin}/`, { method: "HEAD" });
    assertEquals(response.status, 200);
    assertStrictEquals(response.body, null);
  });

  Deno.test(`GET ${origin}/missing is 404`, async () => {
    const response = await fetcher(`${origin}/missing`);
    assertEquals(response.status, 404);
    await response.body?.cancel();
  });

  Deno.test(`POST ${origin}/ is 405`, async () => {
    const response = await fetcher(`${origin}/`, {
      method: "POST",
      body: "a=b",
    });
    assertEquals(response.status, 405);
    await response.text();
  });
}
