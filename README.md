# Convex Cloudflare Email

[![npm version](https://img.shields.io/npm/v/@sarant/cloudflare-email-component)](https://www.npmjs.com/package/@sarant/cloudflare-email-component)
[![license](https://img.shields.io/npm/l/@sarant/cloudflare-email-component)](https://github.com/saranatour1/cloudflare-email-component/blob/main/LICENSE)

<!-- START: Include on https://convex.dev/components -->

A [Convex component](https://www.convex.dev/components) that sends and receives
email through your own Cloudflare account, and keeps a record of every message.

> **This needs Convex.** It runs inside a Convex backend and is installed with
> `app.use`. If your app doesn't use [Convex](https://www.convex.dev), use
> Cloudflare's
> [REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
> or
> [Workers binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
> directly instead.

- **Send** from your Convex actions through Cloudflare Email Sending.
- **Track delivery**: hear about bounces, complaints and deliveries after
  Cloudflare accepts a message.
- **Receive** mail sent to your domain through Cloudflare Email Routing.

Your app stays in charge of who may send, which user owns each message, and how
it's encrypted. The component stores only the strings you give it, and never
stores your API token.

Found a bug or want a feature?
[Open an issue](https://github.com/saranatour1/cloudflare-email-component/issues).
See the
[changelog](https://github.com/saranatour1/cloudflare-email-component/blob/main/CHANGELOG.md)
for what changed in each version.

## Pick what you need

| Use               | You set up                                                  | The API token also needs to manage           |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Send only         | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`             | Email Sending                                |
| + delivery events | `EVENTS_SECRET`, `setUpDeliveryEvents`, `onEvents`          | Queues, Workers Scripts, event subscriptions |
| + receiving       | `INBOUND_SECRET`, `uploadWorker`, `createRule`, `onReceive` | Email Routing rules, Workers Scripts         |

Each level is optional. Start with sending and add the others when you need
them.

## Before you start

1. Sending to any address needs the Workers Paid plan. On the free plan you can
   only send to verified destination addresses. Receiving works on both.
2. Your domain must use Cloudflare DNS. Onboard it under **Compute > Email
   Service > Email Sending** in the dashboard, which adds the SPF, DKIM and
   DMARC records. Until then you can only send to verified destination
   addresses.
3. Create an API token with the permissions in the table above.
4. A new domain has no reputation. Start with low volume and send only to people
   who expect the mail. See Cloudflare's
   [deliverability guide](https://developers.cloudflare.com/email-service/concepts/deliverability/).

## Installation

```sh
pnpm add @sarant/cloudflare-email-component
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import cloudflareEmail from "@sarant/cloudflare-email-component/convex.config.js";

const app = defineApp({
  env: {
    CLOUDFLARE_ACCOUNT_ID: v.optional(v.string()),
    CLOUDFLARE_API_TOKEN: v.optional(v.string()),
    INBOUND_SECRET: v.optional(v.string()),
    EVENTS_SECRET: v.optional(v.string()),
  },
});
app.use(cloudflareEmail, {
  httpPrefix: "/email/",
  env: {
    CLOUDFLARE_ACCOUNT_ID: app.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: app.env.CLOUDFLARE_API_TOKEN,
    INBOUND_SECRET: app.env.INBOUND_SECRET,
    EVENTS_SECRET: app.env.EVENTS_SECRET,
  },
});

export default app;
```

Set the values with `npx convex env set CLOUDFLARE_API_TOKEN ...` and so on.
Never put them in code or in a committed file.

- `httpPrefix: "/email/"` serves the component's routes at `/email/inbound` and
  `/email/events` on your deployment's `.convex.site` URL.
- Every `env` entry is optional. Leave one out to pass that value per call
  instead.
- The component needs `convex` 1.49 or later.

### Entry points

| Import                                                | What's in it                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@sarant/cloudflare-email-component`                  | `sendEmail`, `recordDeliveryEvents`, `parseDeliveryEvents`, `isUndeliverable`, `toBase64`, `vEmail` |
| `@sarant/cloudflare-email-component/cloudflare`       | One-time setup and suppressions: Workers, routing rules, delivery events                            |
| `@sarant/cloudflare-email-component/convex.config.js` | The component, for `app.use`                                                                        |
| `@sarant/cloudflare-email-component/test`             | `register(t)` for `convex-test`                                                                     |

All of it runs in your Convex functions, never in the browser. Apps that only
send don't bundle the setup code. The
[API reference](https://github.com/saranatour1/cloudflare-email-component/blob/main/docs/API.md)
lists every function and its arguments.

## Sending

`sendEmail` records the email, sends it, and stores the result. It returns
`{ emailId, messageId, error, ... }` and doesn't throw when Cloudflare refuses.

```ts
// convex/mail.ts
import { sendEmail, vEmail } from "@sarant/cloudflare-email-component";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

export const send = action({
  args: { email: vEmail },
  handler: async (ctx, { email }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("Unauthorized");
    return await sendEmail(ctx, components.cloudflareEmail, {
      owner: user.tokenIdentifier,
      email,
      seal: (text) => text,
    });
  },
});
```

- **Authorize first.** An action that sends whatever it's given is an open mail
  relay. Check the user, and check that they may use the `from` address.
- **`owner`** is any string you choose, such as the user's `tokenIdentifier`.
  Reads and deletes are scoped by it. The component doesn't check it, so your
  function must.
- **`seal`** receives everything the component is about to store (the email
  without attachments, and any error). Return it encrypted, or return it as is
  to store plain text. It never sees the API token.
- It sends with the credentials bound in `app.use`. Pass `accountId` and
  `apiToken` to override them for one call.

### Addresses

`to`, `cc` and `bcc` each take one address or a list. Each address is a string
or `{ address, name }`. `from` and `replyTo` take one address.

```ts
const email = {
  from: { address: "support@example.com", name: "Support Team" },
  to: ["plain@example.net", { address: "jane@example.net", name: "Jane Doe" }],
  bcc: "archive@example.com",
  replyTo: "help@example.com",
  subject: "Welcome!",
  text: "Thanks for joining!",
};
```

- `from` must be on a domain you onboarded.
- At most 50 recipients across `to`, `cc` and `bcc`. `to` can be left out if
  there's a `cc` or `bcc`.
- One of `text` or `html` is required. Send both when you can.
- The component sends addresses exactly as given. Trim and lowercase addresses
  from user input yourself, so `" Jane@Example.net "` doesn't become a failed
  send or a second suppression entry.
- Use `{ address, name }` for display names rather than building
  `"Jane <jane@...>"` strings by hand.

### Headers

```ts
headers: {
  "List-Unsubscribe": "<https://example.com/unsubscribe?id=abc>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  "X-Campaign-ID": "weekly-2026-11",
}
```

Cloudflare checks headers against an
[allowlist](https://developers.cloudflare.com/email-service/reference/headers/)
and rejects the **whole email** if one fails. The reason comes back in `error`.

- Names on the allowlist, or starting with `X-`, are accepted. `From`, `To`,
  `Subject`, `Reply-To`, `Date`, `Message-ID` and similar are rejected: use the
  matching field, or let Cloudflare set them.
- At most 20 non-`X-` headers, 2,048 bytes per value, and 16 KB in total.
- Values can't be empty or contain line breaks. Strip `\r` and `\n` from
  anything that came from a user, in headers and in `subject`. The subject can
  be at most 998 characters.
- For replies, set `In-Reply-To` and `References` to the original Message-ID so
  mail clients thread them.

### What the result means

| Field              | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `error`            | Nothing was sent. The stored status is `failed`.                   |
| `messageId`        | Cloudflare accepted the email. Keep it for threading and tracking. |
| `delivered`        | Addresses the receiving server accepted right away                 |
| `queued`           | Addresses Cloudflare will keep trying; they can still bounce later |
| `permanentBounces` | Addresses that bounced at once                                     |
| `suppressed`       | Addresses dropped because they're on your suppression list         |

Stored status `sent` means Cloudflare accepted the email, not that it arrived.
Set up [delivery tracking](#delivery-tracking) to learn the outcome. If every
address was refused, `sendEmail` returns an `error` even though Cloudflare
answered with success.

If any recipient is on your suppression list, Cloudflare rejects the whole
email. To send to the rest, turn on **Drop suppressed recipients** for the
sending domain; dropped addresses come back in `suppressed`.

### Retries

A 429 (rate limited) or 503 (unavailable) is retried twice, after 1 and 3
seconds, since Cloudflare didn't send anything. Nothing else is retried, because
Cloudflare takes no idempotency key and a retry could send twice. A send that
dies midway is marked `failed` after 15 minutes.

### Attachments

```ts
import { toBase64 } from "@sarant/cloudflare-email-component";

const file = await ctx.storage.get(storageId);
const attachment = {
  content: toBase64(await file!.arrayBuffer()),
  filename: "invoice.pdf",
  type: "application/pdf",
  disposition: "attachment",
};
```

- Cloudflare takes up to 25 MiB per message after base64 encoding, and at most
  32 attachments.
- Arguments to a Convex function stop at 16 MiB. For anything near that, read
  the file from storage inside your action, as above, and pass `accountId` and
  `apiToken` so the email goes straight from your action to Cloudflare.
- For an inline image, use `disposition: "inline"` with a `content_id`, and
  refer to it as `<img src="cid:logo">`.
- Attachments are sent but **not stored**. The rest of the email must fit in a 1
  MiB document.

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

```ts
export const myMail = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) throw new Error("Unauthorized");
    return await ctx.runQuery(components.cloudflareEmail.lib.list, {
      owner: user.tokenIdentifier,
      direction: "outbound",
      paginationOpts,
    });
  },
});
```

`lib.list`, `lib.page`, `events.list` and `events.page` are paginated, so a
query like this works with `usePaginatedQuery`. A query can make only one
paginated call, counting the component's: to read two lists, use two queries or
an action. Payloads come back sealed, so unseal them in your function before
returning them.

## Suppressions

Cloudflare adds hard bounces and spam complaints to the list itself. It doesn't
process unsubscribe links, so add those yourself:

```ts
import { addSuppression } from "@sarant/cloudflare-email-component/cloudflare";

await addSuppression(accountId, token, { email: "jane@example.net" });
```

`listSuppressions`, `updateSuppression`, `deleteSuppression` and
`importSuppressions` cover the rest. Entries are account-wide unless you pass
`scope: { type: "sending_domain", value: "mail.example.com" }`. Check
`read_only` before changing an entry.

## Delivery tracking

Run this once for each sending domain, from one of your actions, and keep what
it returns so you can undo it with `removeDeliveryEvents`:

```ts
import { setUpDeliveryEvents } from "@sarant/cloudflare-email-component/cloudflare";

const setup = await setUpDeliveryEvents(accountId, token, {
  name: "email-events-example-com",
  zoneId,
  domain: "example.com",
  eventsUrl: `${process.env.CONVEX_SITE_URL}/email/events`,
  secret: process.env.EVENTS_SECRET!,
});
```

It creates a Queue, a dead letter queue, a Worker that reads them, and the event
subscription. If a step fails, it removes what it created.

The route checks the secret and passes each batch to your `onEvents` handler:

```ts
import {
  isUndeliverable,
  parseDeliveryEvents,
  recordDeliveryEvents,
} from "@sarant/cloudflare-email-component";

export const onEvents = internalAction({
  args: { events: v.array(v.any()) },
  returns: v.null(),
  handler: async (ctx, { events }) => {
    const results = await recordDeliveryEvents(
      ctx,
      components.cloudflareEmail,
      {
        owner: "my-app",
        events: parseDeliveryEvents(events),
        seal: (text) => text,
      },
    );
    for (const { event, isNew } of results)
      if (isNew && isUndeliverable(event)) {
        // Stop mailing event.payload.recipient.
      }
    return null;
  },
});
```

- Queues can deliver an event twice. Act only where `isNew` is true.
- `isUndeliverable` is true for a complaint or a hard bounce: stop mailing that
  address.
- If the handler throws, Queues retries the batch five times, a minute apart,
  then keeps it in the dead letter queue.
- Each email gets a `delivery` field with the worst outcome among its
  recipients: `deferred`, `delivered`, then `failed`, `rejected` or `bounced`,
  then `complained`. `events.list` gives the history for one email.
- Events are matched to emails by owner and Message-ID. An event for mail the
  component didn't send still reaches your handler, then is dropped after an
  hour.

### Connecting the handlers

Point the routes at your handlers once, for example from your setup action:

```ts
await ctx.runMutation(components.cloudflareEmail.lib.setHandlers, {
  onReceive: await createFunctionHandle(internal.mail.receive),
  onEvents: await createFunctionHandle(internal.mail.onEvents),
});
```

Each handler is optional, and `setHandlers` changes only what you pass. A
handler with the wrong arguments is a type error. Until a handler is set, its
route answers 503, so Cloudflare keeps the mail or events and tries again.

## Receiving

Set up the inbound Worker and a routing rule for each address, from one of your
actions:

```ts
import {
  createRule,
  routingEnabled,
  ruleFor,
  uploadWorker,
} from "@sarant/cloudflare-email-component/cloudflare";

if (!(await routingEnabled(zoneId, token)))
  throw new Error("Turn on Email Routing for the domain first");
if (await ruleFor(zoneId, token, "support@example.com"))
  throw new Error("That address already has a rule");

await uploadWorker(accountId, token, "my-inbound-worker", {
  inboundUrl: `${process.env.CONVEX_SITE_URL}/email/inbound`,
  secret: process.env.INBOUND_SECRET!,
  forwardTo: "me@gmail.com",
});
await createRule(zoneId, token, "support@example.com", "my-inbound-worker");
```

- Turning on Email Routing replaces the domain's MX records, so the code never
  does it. Leave that to the domain's owner, in the dashboard.
- A second rule for the same address won't run, which is why `ruleFor` checks
  first.
- `forwardTo` is optional and must be a verified destination address. The Worker
  then also forwards a copy there.
- `removeInbound` deletes the rules and the Worker.

The route passes each raw message to your `onReceive` handler. Parse it, decide
the owner, seal what you keep, and store it with `lib.receive`:

```ts
import PostalMime from "postal-mime";

export const receive = internalAction({
  args: {
    raw: v.bytes(),
    envelopeFrom: v.optional(v.string()),
    envelopeTo: v.optional(v.string()),
  },
  returns: v.union(v.literal("accept"), v.literal("reject")),
  handler: async (ctx, { raw, envelopeTo }) => {
    const mail = await PostalMime.parse(raw);
    const owner = await ownerFor(ctx, envelopeTo); // your own lookup
    if (!owner) return "reject";
    await ctx.runMutation(components.cloudflareEmail.lib.receive, {
      owner,
      payload: JSON.stringify({
        from: mail.from,
        subject: mail.subject,
        text: mail.text,
      }),
    });
    return "accept";
  },
});
```

- Return `"reject"` to turn a message away, such as spam. The sender gets a
  bounce, unless there's a `forwardTo`.
- Messages over 15 MiB are turned away before they reach you. What you store
  must fit in a 1 MiB document, so trim it: keep the text and drop attachments
  or store them in file storage.
- If the handler throws, Cloudflare tries again later.
- To check authentication, read the first `Authentication-Results` header of the
  raw message, and trust it only if it comes from `mx.cloudflare.net`. Later
  ones may come from the sender.

The example's
[inbox.ts](https://github.com/saranatour1/cloudflare-email-component/blob/main/example/convex/inbox.ts)
has a complete handler.

## Limits

| Limit                        | Value                    | From       |
| ---------------------------- | ------------------------ | ---------- |
| Recipients per email         | 50                       | Cloudflare |
| Message size                 | 25 MiB, after base64     | Cloudflare |
| Attachments per email        | 32                       | Cloudflare |
| Subject                      | 998 characters           | Cloudflare |
| Custom headers               | 20 non-`X-`, 16 KB total | Cloudflare |
| Function arguments           | 16 MiB                   | Convex     |
| Stored email or event        | 1 MiB                    | Convex     |
| Inbound message to the route | 15 MiB                   | Component  |

## Trade-offs

What this component chooses, and what that costs you:

- **No automatic retries.** Only a 429 or 503 is retried, because Cloudflare has
  no idempotency key and a retry could send the same email twice. For guaranteed
  delivery after a timeout, queue sends yourself, for example with
  `@convex-dev/workpool`, and accept that a rare email may go out twice.
- **Attachments aren't stored.** They'd quickly exceed the 1 MiB document limit.
  Keep files in Convex file storage and attach them at send time.

## Testing

```ts
import { convexTest } from "convex-test";
import component from "@sarant/cloudflare-email-component/test";

const t = convexTest(schema, modules);
component.register(t);
```

- The component reads its `env` from `process.env` in tests, so `vi.stubEnv`
  sets it.
- `t.fetch` reaches only your app's routes, so call your handlers directly.
- Mock `fetch` to keep tests off Cloudflare.

## Not covered

- SMTP and the Workers `send_email` binding. Convex calls the REST API, which
  takes the same fields.
- Parsing inbound MIME. Use something like `postal-mime` in your handler.
- Templates. Render your HTML before calling `sendEmail`.

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

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with
`pnpm exec convex env set`, then send a test:

```sh
pnpm exec convex run example:send '{"email":{"from":"me@example.com","to":["you@example.com"],"subject":"Hi","text":"Hello"}}'
```

The example also has an inbox at `https://<deployment>.convex.site/inbox`, with
one inbox per address, threads and replies. Set `INBOUND_SECRET`, turn on Email
Routing for the domain, and route each address to it:

```sh
pnpm exec convex run inbox:setUpInbox '{"zoneId":"<zone id>","addresses":["support@example.com"]}'
```

The inbox has no sign-in, so anyone with its URL can read that mail and reply as
your domain. Put your own auth in front of it before using it with real mail.

Run `pnpm test` to test the component, its client and the example.

## Releasing

1. Add your changes under `## Unreleased` at the top of `CHANGELOG.md`, and
   commit.
2. On `main`, run `pnpm release` for a fix, or `pnpm release:minor` for a new
   feature or a breaking change.
3. Approve the new version under **Staged Packages** on npmjs.com.

The script runs the tests, lint and typecheck, turns `## Unreleased` into the
new version's heading, commits, tags and pushes. The tag starts the
[Publish workflow](https://github.com/saranatour1/cloudflare-email-component/blob/main/.github/workflows/publish.yml),
which checks everything again and stages the version on npm through trusted
publishing, so no npm token is stored anywhere. npm adds a provenance badge
linking each version to the commit it was built from. `pnpm alpha` does the same
for a prerelease under the `alpha` tag.

The workflow also creates a GitHub Release from the version's changelog section,
and mirrors the package to GitHub Packages as
`@saranatour1/cloudflare-email-component`, so both show on the repository page.
Install from npm as usual: the mirror needs a GitHub token to install. To add
them for an existing tag, run the Publish workflow by hand with that tag.

## References

Cloudflare:

- [Email Service overview](https://developers.cloudflare.com/email-service/)
- [Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
- [Email headers allowlist](https://developers.cloudflare.com/email-service/reference/headers/)
- [Limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Suppressions](https://developers.cloudflare.com/email-service/concepts/suppressions/)
- [Deliverability](https://developers.cloudflare.com/email-service/concepts/deliverability/)
- [Email Sending event subscriptions](https://developers.cloudflare.com/email-service/reference/event-subscriptions/)
- [Email Routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Email Routing Workers (`email()` handler)](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Queues event subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/)

Convex:

- [Convex components](https://www.convex.dev/components)
- [Using components](https://docs.convex.dev/components)
- [HTTP actions](https://docs.convex.dev/functions/http-actions)
- [Environment variables](https://docs.convex.dev/production/environment-variables)
