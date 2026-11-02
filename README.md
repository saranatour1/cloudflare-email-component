# Convex Cloudflare Email

[![npm version](https://badge.fury.io/js/@saranatour1%2Fcloudflare-email-component.svg)](https://badge.fury.io/js/@saranatour1%2Fcloudflare-email-component)

<!-- START: Include on https://convex.dev/components -->

Send and receive email through your own Cloudflare account from Convex, and keep
a record of it. Your app decides who may send and how mail is encrypted: the
component stores only opaque strings and never stores your API token.

Found a bug? Feature request?
[File it here](https://github.com/saranatour1/cloudflare-email-component/issues).

## Installation

```sh
pnpm add @saranatour1/cloudflare-email-component
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import cloudflareEmail from "@saranatour1/cloudflare-email-component/convex.config.js";

const app = defineApp();
app.use(cloudflareEmail);

export default app;
```

## Sending

`sendEmail` queues the email, sends it, and records the result. It returns
`{ emailId, messageId, error }` rather than throwing when Cloudflare refuses.

```ts
import { sendEmail, vEmail } from "@saranatour1/cloudflare-email-component";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

export const send = action({
  args: { email: vEmail },
  handler: async (ctx, { email }) => {
    // Authorize first: an open action here is an open mail relay.
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("Unauthorized");
    return await sendEmail(ctx, components.cloudflareEmail, {
      owner: user.tokenIdentifier,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
      apiToken: process.env.CLOUDFLARE_API_TOKEN!,
      email,
      // What gets stored goes through here, so encrypt it if you need to.
      seal: (text) => text,
    });
  },
});
```

Requests that Cloudflare answers with a 429 or 503 are retried twice. Nothing
else is, because Cloudflare takes no idempotency key and a retry could send
twice. An email whose send dies midway is marked `failed` after 15 minutes.
Attachments are sent but not stored.

## Reading and deleting

Component functions can only be called from your own functions, so authorize
there:

| Function          | What it does                                      |
| ----------------- | ------------------------------------------------- |
| `lib.get`         | One email by id                                   |
| `lib.list`        | An owner's inbound or outbound mail, newest first |
| `lib.page`        | A page across all owners, for re-encrypting       |
| `lib.reseal`      | Replace a payload if it hasn't changed            |
| `lib.remove`      | Delete one email, if it's that owner's            |
| `lib.removeOwner` | Delete a batch of an owner's mail                 |

## Receiving

Cloudflare Email Routing hands mail to a Worker, which posts it to your app.
These helpers run in your own actions and set that up:

```ts
import {
  createRule,
  routingEnabled,
  ruleFor,
  uploadWorker,
} from "@saranatour1/cloudflare-email-component";

await uploadWorker(accountId, token, "my-inbound-worker", {
  inboundUrl: `${process.env.CONVEX_SITE_URL}/email/inbound`,
  secret,
  forwardTo, // optional
});
await createRule(zoneId, token, "me@example.com", "my-inbound-worker");
```

Check `routingEnabled` first: turning Email Routing on replaces the domain's MX
records, so leave that to the domain's owner. Check `ruleFor` too, since a
second rule for the same address won't run. `removeInbound` undoes the setup,
and `tokenStatus` and `accessOf` report what a token can reach.

The route that takes the Worker's post, and calls `lib.receive`, is yours. See
[http.ts](./example/convex/http.ts). The Worker reads its reply this way: a 403
turns the message away unless there's an address to forward it to, and any other
failure makes Cloudflare try again later.

## Testing

```ts
import component from "@saranatour1/cloudflare-email-component/test";

const t = convexTest(schema, modules);
component.register(t);
```

<!-- END: Include on https://convex.dev/components -->

## Running the example

```sh
pnpm install
pnpm run dev
```

Then set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with
`pnpm exec convex env set`, and try it:

```sh
pnpm exec convex run example:send '{"email":{"from":"me@example.com","to":["you@example.com"],"subject":"Hi","text":"Hello"}}'
```

Run `pnpm test` to test the component, its client, and the example.
