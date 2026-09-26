# @pixel/socket-fetch

A `fetch`-compatible HTTP/1.1 client that runs over a socket API you provide. It works on Deno and Cloudflare Workers.

## Usage

`createFetcher` takes a `connect` function for `http:` URLs and a `connectTls` function for `https:` URLs, and returns a function with the same signature as `fetch`.

### Deno

```sh
deno add jsr:@pixel/socket-fetch
```

```ts
import { createFetcher } from "@pixel/socket-fetch";

const fetch = createFetcher({
  connect: Deno.connect,
  connectTls: Deno.connectTls,
});

const response = await fetch("https://example.com/");
console.log(await response.text());
```

Run with `--allow-net`.

### Cloudflare Workers

```sh
npx jsr add @pixel/socket-fetch
```

```ts ignore
import { connect } from "cloudflare:sockets";
import { createFetcher } from "@pixel/socket-fetch";

const fetch = createFetcher({
  connect,
  connectTls: (address) =>
    connect(address, { secureTransport: "on", allowHalfOpen: false }),
});
```

Workers block `connect()` to Cloudflare IP ranges, so hosts behind Cloudflare cannot be reached this way.

### Customizing connections

Wrap `connect`/`connectTls` to change how connections are made, for example to trust a custom CA certificate:

```ts
import { createFetcher } from "@pixel/socket-fetch";

const ca = await Deno.readTextFile("./ca.pem");

const fetch = createFetcher({
  connect: Deno.connect,
  connectTls: (address) => Deno.connectTls({ ...address, caCerts: [ca] }),
});
```

## Limitations

- HTTP/1.1 only, one connection per request.
- Only `gzip` and `deflate` responses are decoded; other content codings are returned as received.

## License

MIT
