import { connect } from "cloudflare:sockets";
import { assertEquals, assertStrictEquals } from "@std/assert";
import { createFetcher } from "../../mod.ts";

const fetcher = createFetcher({
  connect,
  connectTls: (address) => connect(address, { secureTransport: "on" }),
});

export default {
  async test() {
    for (const origin of ["http://example.com", "https://example.com"]) {
      const [ours, native] = await Promise.all([
        fetcher(`${origin}/`),
        fetch(`${origin}/`),
      ]);
      assertEquals(ours.status, 200);
      assertEquals(ours.statusText, "OK");
      assertEquals(ours.url, `${origin}/`);
      assertEquals(ours.headers.get("content-type"), "text/html");
      assertEquals(await ours.text(), await native.text());

      const head = await fetcher(`${origin}/`, { method: "HEAD" });
      assertEquals(head.status, 200);
      assertStrictEquals(head.body, null);

      const missing = await fetcher(`${origin}/missing`);
      assertEquals(missing.status, 404);
      await missing.body?.cancel();

      const post = await fetcher(`${origin}/`, { method: "POST", body: "a=b" });
      assertEquals(post.status, 405);
      await post.text();

      console.log(`${origin} ok`);
    }
  },
};
