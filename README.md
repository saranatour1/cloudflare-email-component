# Convex Cloudflare Email

[![npm version](https://badge.fury.io/js/@saranatour1%2Fcloudflare-email-component.svg)](https://badge.fury.io/js/@saranatour1%2Fcloudflare-email-component)

<!-- START: Include on https://convex.dev/components -->

Send and receive email through your own Cloudflare account from Convex, and keep
a record of it. Your app decides who may send and how mail is encrypted: the
component stores only opaque strings and never stores your API token.

Found a bug? Feature request?
[File it here](https://github.com/saranatour1/cloudflare-email-component/issues).

## Before you start

1. Your domain must use Cloudflare DNS. Onboard it under **Compute > Email
   Service > Email Sending** in the dashboard, which adds the SPF, DKIM and
   DMARC records. Until then you can only send to verified destination
   addresses.
2. Create an API token with the **Email Sending: Edit** permission.
3. A new domain has no reputation, so start with low volume and send only to
   people who expect the mail. See Cloudflare's
   [deliverability guide](https://developers.cloudflare.com/email-service/concepts/deliverability/).

## Installation

```sh
pnpm add @saranatour1/cloudflare-email-component
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import cloudflareEmail from "@saranatour1/cloudflare-email-component/convex.config.js";

const app = defineApp({
  env: {
    CLOUDFLARE_ACCOUNT_ID: v.optional(v.string()),
    CLOUDFLARE_API_TOKEN: v.optional(v.string()),
    INBOUND_SECRET: v.optional(v.string()),
    EVENTS_SECRET: v.optional(v.string()),
  },
});
app.use(cloudflareEmail, {
  // Serves the component's routes at /email/inbound and /email/events.
  httpPrefix: "/email/",
  // By reference, so the component sees a new value as soon as it's set.
  env: {
    CLOUDFLARE_ACCOUNT_ID: app.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: app.env.CLOUDFLARE_API_TOKEN,
    INBOUND_SECRET: app.env.INBOUND_SECRET,
    EVENTS_SECRET: app.env.EVENTS_SECRET,
  },
});

export default app;
```

Every `env` entry and the `httpPrefix` are optional. Leave them out to pass
credentials to each call and serve the routes yourself. The component needs
`convex` 1.49 or later. The
[API reference](https://github.com/saranatour1/cloudflare-email-component/blob/main/docs/API.md)
lists every function.

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
      email,
      // What gets stored goes through here, so encrypt it if you need to.
      seal: (text) => text,
    });
  },
});
```

It sends with the credentials bound in `app.use`. For an email over 16 MiB, pass
`accountId` and `apiToken` as well: it then sends straight from your action, up
to Cloudflare's 25 MiB. Without credentials anywhere, the email is recorded as
`failed` with the reason.

Requests that Cloudflare answers with a 429 or 503 are retried twice. Nothing
else is, because Cloudflare takes no idempotency key and a retry could send
twice. An email whose send dies midway is marked `failed` after 15 minutes.

### Addressing

`to`, `cc` and `bcc` each take one address or a list, and every address is a
string or `{ address, name }`. `from` and `replyTo` take a single address. At
most 50 recipients in total. `to` is optional if there's a `cc` or `bcc`, and
one of `text` or `html` is required.

```ts
const email = {
  from: { address: "support@example.com", name: "Support Team" },
  to: ["plain@example.net", { address: "jane@example.net", name: "Jane Doe" }],
  bcc: "archive@example.com",
  replyTo: "help@example.com",
  subject: "Welcome!",
  text: "Thanks for joining!",
  headers: { "List-Unsubscribe": "<https://example.com/unsubscribe?id=abc>" },
};
```

Cloudflare rejects the whole email if a header isn't on its
[allowlist](https://developers.cloudflare.com/email-service/reference/headers/),
and the reason comes back as `error`. Use `In-Reply-To` and `References` for
threading.

### What the result means

`sendEmail` also returns `delivered`, `queued`, `permanentBounces` and
`suppressed`, each a list of addresses. Stored status `sent` means Cloudflare
accepted the email, not that it arrived, since a `queued` address can still
bounce later. Set up [delivery tracking](#delivery-tracking) to hear about that.
Only `error` means nothing went out.

If any recipient is on your [suppression list](#suppressions), Cloudflare
rejects the whole email with a 400. To send to the others instead, turn on
**Drop suppressed recipients** for the sending domain, and those addresses come
back in `suppressed`.

### Attachments

Cloudflare takes up to 25 MiB per message, after base64 encoding. Function
arguments stop at 16 MiB, so read large files from storage inside your action:

```ts
const file = await ctx.storage.get(storageId);
const attachment = {
  content: toBase64(await file!.arrayBuffer()),
  filename: "invoice.pdf",
  type: "application/pdf",
  disposition: "attachment",
};
```

For an inline image, use `disposition: "inline"` with a `content_id`, and refer
to it as `<img src="cid:logo">`. Attachments are sent but not stored, and the
rest of the email must fit in a 1 MiB document. Calling `lib.send` directly
stops at 16 MiB, so use `sendEmail` with `accountId` and `apiToken` for anything
large.

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

`lib.list`, `lib.page`, `events.list` and `events.page` take `paginationOpts`
and return `{ page, isDone, continueCursor }`, so a query that passes a client's
`paginationOpts` straight through works with `usePaginatedQuery`. A query can
make only one paginated call, counting the component's: to read two lists, use
an action or two queries.

## Suppressions

Cloudflare adds bounces and spam complaints to the list itself. Add your own for
unsubscribes, since it doesn't process unsubscribe links:

```ts
import { addSuppression } from "@saranatour1/cloudflare-email-component";

await addSuppression(accountId, token, { email: "jane@example.net" });
```

`listSuppressions`, `updateSuppression`, `deleteSuppression` and
`importSuppressions` cover the rest. Check `read_only` before changing an entry.
Entries are account-wide unless you pass
`scope: { type: "sending_domain", value: "mail.example.com" }`.

## Delivery tracking

Cloudflare publishes what happens after it accepts an email to a Queue. A small
Worker reads that Queue and posts to the component's `/email/events` route, the
same way inbound mail arrives. Set it up once for each sending domain, from one
of your actions:

```ts
import { setUpDeliveryEvents } from "@saranatour1/cloudflare-email-component";

// Keep the result for removeDeliveryEvents.
const setup = await setUpDeliveryEvents(accountId, token, {
  name: "email-events-example-com",
  zoneId,
  domain: "example.com",
  eventsUrl: `${process.env.CONVEX_SITE_URL}/email/events`,
  secret,
});
```

Use `EVENTS_SECRET` as the `secret`. The token also needs to manage Queues,
Workers and event subscriptions. The route checks the secret and hands each
batch to your `onEvents` handler, where the owner and the sealing are yours:

```ts
export const onEvents = internalAction({
  args: { events: v.array(v.any()) },
  returns: v.null(),
  handler: async (ctx, { events }) => {
    const results = await recordDeliveryEvents(
      ctx,
      components.cloudflareEmail,
      {
        owner,
        events: parseDeliveryEvents(events),
        seal, // Each event holds the recipient and subject.
      },
    );
    for (const { event, isNew } of results)
      if (isNew && isUndeliverable(event)) {
        // Take event.payload.recipient off your own lists.
      }
    return null;
  },
});
```

Point the routes at your handlers once, for example from your setup action.
`v.function` checks the handles, so a handler with the wrong signature is a type
error:

```ts
await ctx.runMutation(components.cloudflareEmail.lib.setHandlers, {
  onReceive: await createFunctionHandle(internal.mail.receive),
  onEvents: await createFunctionHandle(internal.mail.onEvents),
});
```

Until a handler is set, the route answers 503, so nothing is lost. A handler
that throws makes Queues retry the batch, five times a minute apart, and then
keep it in a dead letter queue.

Each email gets a `delivery` field with the worst outcome among its recipients,
from best to worst: `deferred`, `delivered`, then `failed`, `rejected` or
`bounced`, then `complained`. `events.list` gives the event history for one
email, and each event's sealed payload says which recipient it's about.

Events are matched to emails by owner and Message-ID. One for mail the component
didn't send is still returned to your handler, then dropped after an hour.
Deleting an email deletes its events too. To re-encrypt them, use `events.page`
and `events.reseal`.

## Receiving

Cloudflare Email Routing hands mail to a Worker, which posts it to the
component's `/email/inbound` route. These helpers run in your own actions and
set that up:

```ts
import {
  createRule,
  routingEnabled,
  ruleFor,
  uploadWorker,
} from "@saranatour1/cloudflare-email-component";

await uploadWorker(accountId, token, "my-inbound-worker", {
  inboundUrl: `${process.env.CONVEX_SITE_URL}/email/inbound`,
  secret, // INBOUND_SECRET
  forwardTo, // optional
});
await createRule(zoneId, token, "me@example.com", "my-inbound-worker");
```

Check `routingEnabled` first: turning Email Routing on replaces the domain's MX
records, so leave that to the domain's owner. Check `ruleFor` too, since a
second rule for the same address won't run. `removeInbound` undoes the setup,
and `tokenStatus` and `accessOf` report what a token can reach.

Domain setup is in **Email Routing** in the dashboard. `forwardTo` must be a
verified destination address.

To check authentication, read the first `Authentication-Results` header of the
raw message, and trust it only if it comes from `mx.cloudflare.net`. Later ones
may come from the sender.

The route checks the secret and hands the raw message to your `onReceive`
handler, set with `setHandlers` as above. Your handler parses it, picks the
owner, seals it, and calls `lib.receive`:

```ts
export const receive = internalAction({
  args: {
    raw: v.bytes(),
    envelopeFrom: v.optional(v.string()),
    envelopeTo: v.optional(v.string()),
  },
  returns: v.union(v.literal("accept"), v.literal("reject")),
  handler: async (ctx, { raw, envelopeTo }) => {
    // Parse with something like postal-mime, and seal what you keep.
    await ctx.runMutation(components.cloudflareEmail.lib.receive, {
      owner,
      payload,
    });
    return "accept";
  },
});
```

Return `"reject"` to turn a message away, such as spam: it bounces unless
there's an address to forward it to. A message over 15 MiB is turned away before
it reaches you. If the handler throws, or none is set yet, Cloudflare tries
again later. See [inbox.ts](./example/convex/inbox.ts) for a whole handler.

## Not covered

- SMTP and the Workers `send_email` binding. Convex functions call the REST API
  instead, which takes the same fields.
- MIME parsing of inbound mail. Use something like `postal-mime` in your
  `onReceive` handler.

## Testing

```ts
import component from "@saranatour1/cloudflare-email-component/test";

const t = convexTest(schema, modules);
component.register(t);
```

The component reads its `env` from `process.env` there, so `vi.stubEnv` sets it.
`t.fetch` reaches only your app's routes, so call your handlers directly.

<!-- END: Include on https://convex.dev/components -->

## Running the example

```sh
pnpm install
pnpm run dev
```

To run it on a local backend instead, with the API on port 5712 and the HTTP
routes on 5713:

```sh
pnpm exec convex deployment create local --select
pnpm run dev --local-cloud-port 5712 --local-site-port 5713
```

Then set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with
`pnpm exec convex env set`, and try it:

```sh
pnpm exec convex run example:send '{"email":{"from":"me@example.com","to":["you@example.com"],"subject":"Hi","text":"Hello"}}'
```

The example also has an inbox at `https://<deployment>.convex.site/inbox`: one
inbox per address mail comes in on, with threads and replies. Set
`INBOUND_SECRET`, turn on Email Routing for the domain, and route each address
to it. This also points the component's routes at the example's handlers, which
`example:connect` does on its own:

```sh
pnpm exec convex run inbox:setUpInbox '{"zoneId":"<zone id>","addresses":["support@example.com","hello@example.com"]}'
```

The inbox has no sign-in, so anyone with its URL can read that mail and reply as
your domain. It's for trying things out: put your own auth in front of it before
using it with real mail.

Run `pnpm test` to test the component, its client, and the example.
