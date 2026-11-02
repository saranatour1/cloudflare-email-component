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
stops at 16 MiB, so use `sendEmail` for anything large.

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
Worker reads that Queue and posts to a route in your app, the same way inbound
mail arrives. Set it up once for each sending domain, from one of your actions:

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

The token also needs to manage Queues, Workers and event subscriptions. Then
take the Worker's posts in your own route:

```ts
const body: unknown = await req.json().catch(() => null);
if (!Array.isArray(body)) return new Response(null, { status: 400 });

const results = await recordDeliveryEvents(ctx, components.cloudflareEmail, {
  owner,
  events: parseDeliveryEvents(body),
  seal, // Each event holds the recipient and subject.
});
for (const { event, isNew } of results)
  if (isNew && isUndeliverable(event)) {
    // Take event.payload.recipient off your own lists.
  }
return new Response(null, { status: 204 });
```

See [http.ts](./example/convex/http.ts) for the whole route, including checking
the secret. A failed response makes Queues retry the batch, five times a minute
apart, and then keep it in a dead letter queue.

Each email gets a `delivery` field with the worst outcome among its recipients,
from best to worst: `deferred`, `delivered`, then `failed`, `rejected` or
`bounced`, then `complained`. `events.list` gives the event history for one
email, and each event's sealed payload says which recipient it's about.

Events are matched to emails by owner and Message-ID. One for mail the component
didn't send is still returned to your route, then dropped after an hour.
Deleting an email deletes its events too. To re-encrypt them, use `events.page`
and `events.reseal`.

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

Domain setup is in **Email Routing** in the dashboard. `forwardTo` must be a
verified destination address. To reject mail for your own reasons, such as spam,
return a 403 from your route.

To check authentication, read the first `Authentication-Results` header of the
raw message, and trust it only if it comes from `mx.cloudflare.net`. Later ones
may come from the sender.

The route that takes the Worker's post, and calls `lib.receive`, is yours. See
[http.ts](./example/convex/http.ts). The Worker reads its reply this way: a 403
turns the message away unless there's an address to forward it to, and any other
failure makes Cloudflare try again later.

## Not covered

- SMTP and the Workers `send_email` binding. Convex functions call the REST API
  instead, which takes the same fields.
- MIME parsing of inbound mail. Use something like `postal-mime` in your route.

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
