# API reference

Rough reference for `@sarant/cloudflare-email-component`. The
[README](../README.md) has the walkthrough, and this page lists every export.

## Install

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

The component is then `components.cloudflareEmail` in your functions. It needs
`convex` 1.49 or later.

Every `env` entry and the `httpPrefix` are optional. Without them,
`app.use(cloudflareEmail)` still works: you pass credentials to each call and
serve the routes yourself. Set the values on the deployment:

```sh
pnpm convex env set CLOUDFLARE_ACCOUNT_ID <account id>
pnpm convex env set CLOUDFLARE_API_TOKEN <token>
printf %s "$(openssl rand -hex 32)" | pnpm convex env set INBOUND_SECRET
printf %s "$(openssl rand -hex 32)" | pnpm convex env set EVENTS_SECRET
```

The token needs **Email Sending: Edit**. To receive mail it also needs **Email
Routing Rules: Edit** and **Workers Scripts: Edit**, and delivery tracking needs
Queues and event subscriptions too.

## Package entry points

| Import                                                       | What it is                                |
| ------------------------------------------------------------ | ----------------------------------------- |
| `@sarant/cloudflare-email-component`                         | Client helpers, run in your own actions   |
| `@sarant/cloudflare-email-component/cloudflare`              | Cloudflare account setup and suppressions |
| `@sarant/cloudflare-email-component/convex.config.js`        | The component, for `app.use`              |
| `@sarant/cloudflare-email-component/test`                    | `register(t)` for `convex-test`           |
| `@sarant/cloudflare-email-component/_generated/component.js` | `ComponentApi` type                       |

## Concepts

- **owner**: a string you choose, such as a user's `tokenIdentifier`. The
  component scopes everything by it and doesn't check it, so authorize in your
  own functions first.
- **seal**: `(text) => string | Promise<string>`. Whatever the component stores
  (the email JSON, errors, event payloads) goes through it. Encrypt here, or
  pass `(text) => text` to store plain text. The component never stores the API
  token.
- **status**: `queued`, `sent`, `failed` or `received`. `sent` means Cloudflare
  accepted it, not that it arrived.
- **delivery**: the worst outcome so far among the recipients, one of
  `deferred`, `delivered`, `failed`, `rejected`, `bounced` or `complained`.

## Types

### `Email` / `vEmail`

```ts
type Address = string | { address: string; name?: string };

type Email = {
  from: Address;
  to?: Address | Address[];
  cc?: Address | Address[];
  bcc?: Address | Address[];
  replyTo?: Address;
  subject: string;
  text?: string;
  html?: string;
  attachments?: (
    | {
        content: string;
        filename: string;
        type: string;
        disposition: "attachment";
      }
    | {
        content: string;
        filename: string;
        type: string;
        disposition: "inline";
        content_id: string;
      }
  )[];
  headers?: Record<string, string>;
};
```

`vEmail` is the matching validator, for your own `args`. It needs one of `to`,
`cc` or `bcc`, and one of `text` or `html`. There can be at most 50 recipients
in total. `content` is base64, and a message can be up to 25 MiB.

### `DeliveryEvent`

One Cloudflare event for one recipient. `type` is
`cf.email.sending.message.{delivered,deferred,bounced,failed,rejected,complained}`,
and `payload` carries `eventId`, `messageId` and `recipient`, plus optional
`subject`, `bounce`, `failure`, `rejection` and `complaint` details.

### `Suppression`

```ts
{ id; email; reason: "manual" | "complaint" | "hard_bounce" | "soft_bounce" | "policy";
  read_only; created_at; expires_at: string | null; note?; scope? }
```

## Client functions

These run in your actions. Each one calls Cloudflare from your deployment, so
the token stays in your code.

### Sending

#### `sendEmail(ctx, component, { owner, accountId?, apiToken?, email, seal })`

Queues, sends and records one email. Leave out `accountId` and `apiToken` to use
the ones bound in `app.use`. That sends from the component, which caps the email
at a function argument's 16 MiB. Pass them to send straight from your action, up
to Cloudflare's 25 MiB. It returns rather than throws when Cloudflare refuses,
or when there are no credentials:

```ts
{
  emailId: Id<"emails">;
  messageId?: string;        // Set when Cloudflare accepted the email
  error?: string;            // Set when nothing went out
  delivered?: string[];
  queued?: string[];
  permanentBounces?: string[];
  suppressed?: string[];
}
```

A 429 or 503 is retried twice. An email whose send dies midway is marked
`failed` after 15 minutes. Attachments are sent but not stored.

Setup, receiving and suppression helpers come from
`@sarant/cloudflare-email-component/cloudflare`, so apps that only send don't
bundle them.

### Delivery tracking

#### `setUpDeliveryEvents(accountId, token, { name, zoneId, domain, eventsUrl, secret })`

Creates a queue, a dead letter queue, a Worker named `name` that reads them, and
the event subscription for `domain`. The Worker posts each batch to `eventsUrl`
as a JSON array with `Authorization: Bearer <secret>`. With the routes mounted,
that's `${CONVEX_SITE_URL}/email/events` and `EVENTS_SECRET`. Run it once per
sending domain, and keep the `{ queueId, deadLetterQueueId, subscriptionId }` it
returns. If a step fails, it removes whatever it already created.

#### `removeDeliveryEvents(accountId, token, name, setup)`

Undoes `setUpDeliveryEvents`.

#### `parseDeliveryEvents(body: unknown[]): DeliveryEvent[]`

Keeps the events it recognizes from a Worker's post and drops anything else. The
`/events` route already runs it, and your `onEvents` handler can run it again to
get typed events.

#### `recordDeliveryEvents(ctx, component, { owner, events, seal })`

Stores the events and updates each matching email's `delivery`. It returns
`{ eventId, isNew, emailId?, event }[]`. Queues can deliver an event twice, so
act only where `isNew` is true.

#### `isUndeliverable(event): boolean`

True for a complaint or a hard bounce, which means stop mailing that address.

### Receiving

#### `uploadWorker(accountId, token, name, { inboundUrl, secret, forwardTo? })`

Uploads the Email Routing Worker. It posts each raw message to `inboundUrl` with
`Authorization: Bearer <secret>`, `X-Envelope-From` and `X-Envelope-To`. With
the routes mounted, that's `${CONVEX_SITE_URL}/email/inbound` and
`INBOUND_SECRET`. The route's answer decides what happens to the message:

- 2xx: the message is taken.
- 403: the message is rejected, unless there's a `forwardTo` address, which
  still gets it.
- Anything else: Cloudflare tries again later.

#### `createRule(zoneId, token, address, worker, name?): Promise<string>`

Routes `address` to the Worker and returns the rule's ID.

#### `ruleFor(zoneId, token, address)`

Returns `{ id, forwardsTo? }` for an enabled rule that already handles
`address`, or `undefined`. A second rule for the same address won't run, so
check this first.

#### `routingEnabled(zoneId, token): Promise<boolean | undefined>`

Whether Email Routing is on for the zone. Turning it on replaces the zone's MX
records, so leave that to the domain owner.

#### `removeInbound(accountId, zoneId, token, worker, ruleId, aliasRules?)`

Deletes the rules and then the Worker.

## HTTP routes and handlers

With `httpPrefix: "/email/"`, the component serves two routes. Each one checks
its secret from `env`, then hands what it was sent to a function in your app.
The owner and the sealing stay your decisions.

| Route                 | Secret           | Hands to    | Answers                                                                 |
| --------------------- | ---------------- | ----------- | ----------------------------------------------------------------------- |
| `POST /email/inbound` | `INBOUND_SECRET` | `onReceive` | 204 if kept, 403 if rejected or over 15 MiB, 503 until a handler is set |
| `POST /email/events`  | `EVENTS_SECRET`  | `onEvents`  | 204, 400 for anything but a list, 503 until a handler is set            |

A wrong or missing secret gets a 401. A 503 makes Cloudflare and Queues try
again later, so nothing is lost before you set the handlers.

Register the handlers once, for example from your setup action. The handles are
checked with `v.function`, so passing a function with the wrong signature is a
type error:

```ts
import { createFunctionHandle } from "convex/server";

export const connect = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.cloudflareEmail.lib.setHandlers, {
      onReceive: await createFunctionHandle(internal.mail.receive),
      onEvents: await createFunctionHandle(internal.mail.onEvents),
    });
  },
});

// Parse the MIME (for example with postal-mime), then store it.
export const receive = internalAction({
  args: {
    raw: v.bytes(),
    envelopeFrom: v.optional(v.string()),
    envelopeTo: v.optional(v.string()),
  },
  returns: v.union(v.literal("accept"), v.literal("reject")),
  handler: async (ctx, { raw, envelopeTo }) => {
    await ctx.runMutation(components.cloudflareEmail.lib.receive, {
      owner: ownerOf(envelopeTo),
      payload: await seal(parse(raw)),
    });
    return "accept";
  },
});

// Queues can deliver an event twice: act only where isNew is true.
export const onEvents = internalAction({
  args: { events: v.array(v.any()) },
  returns: v.null(),
  handler: async (ctx, { events }) => {
    await recordDeliveryEvents(ctx, components.cloudflareEmail, {
      owner,
      events: parseDeliveryEvents(events),
      seal,
    });
    return null;
  },
});
```

`setHandlers` changes only what you pass, so you can set the two handlers from
different places. A handler that throws makes the sender try again.

### Suppressions

| Function                                                          | Returns                                      |
| ----------------------------------------------------------------- | -------------------------------------------- |
| `listSuppressions(accountId, token, filter?)`                     | `{ suppressions, cursor }`                   |
| `addSuppression(accountId, token, entry)`                         | `{ id, scope }`                              |
| `importSuppressions(accountId, token, entries)`                   | At most 1,000 entries, and 10 calls a minute |
| `updateSuppression(accountId, token, id, { expires_at?, note? })` | The updated entry                            |
| `deleteSuppression(accountId, token, id)`                         |                                              |

`filter` takes `email`, `reason`, `scope_type`, `scope_value`, `search`,
`per_page` and `cursor`. An entry is `{ email, expires_at?, note?, scope? }`,
where `scope` is `{ type: "sending_domain", value }`. Leave `scope` out for an
account-wide entry. Entries with `read_only` set can't be changed.

### Utilities

- `toBase64(bytes: ArrayBuffer)`: for attachment `content`.
- `inboundWorker` and `eventsWorker`, from `/cloudflare`: the source of the two
  Workers, as strings.

## Component functions

Call these with `ctx.runQuery` or `ctx.runMutation` on
`components.cloudflareEmail.*`. Only your own functions can call them.

The `list` and `page` queries take `paginationOpts` (`paginationOptsValidator`
from `convex/server`) and return `{ page, isDone, continueCursor }`. Pass a
client's `paginationOpts` straight through to use them with `usePaginatedQuery`.
A query can make only one paginated call, counting the component's, so read two
lists from an action or from two queries.

### `lib`

| Function                      | Kind     | Args                                   | Returns                                                                     |
| ----------------------------- | -------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `get`                         | query    | `{ emailId }`                          | The email doc, or `null`                                                    |
| `list`                        | query    | `{ owner, direction, paginationOpts }` | One owner's mail, newest first                                              |
| `page`                        | query    | `{ paginationOpts }`                   | Every owner's mail, as `{ _id, owner, payload, error? }`, for re-encrypting |
| `reseal`                      | mutation | `{ emailId, from, payload, error? }`   | Replaces the payload only if it still equals `from`                         |
| `receive`                     | mutation | `{ owner, payload }`                   | The new inbound email's ID                                                  |
| `remove`                      | mutation | `{ emailId, owner }`                   | Deletes it and its events, if it's that owner's                             |
| `removeOwner`                 | mutation | `{ owner, limit? }`                    | `true` while there's more to delete                                         |
| `setHandlers`                 | mutation | `{ onReceive?, onEvents? }`            | Points the HTTP routes at your functions                                    |
| `queue`, `markResult`, `send` |          |                                        | Used by `sendEmail`. Call `sendEmail` instead                               |

`direction` is `"inbound"` or `"outbound"`. An email doc is
`{ _id, _creationTime, owner, direction, status, payload, error?, messageId?, delivery? }`,
where `payload` and `error` are whatever `seal` returned.

### `events`

| Function | Kind     | Args                          | Returns                            |
| -------- | -------- | ----------------------------- | ---------------------------------- |
| `list`   | query    | `{ emailId, paginationOpts }` | That email's delivery events       |
| `page`   | query    | `{ paginationOpts }`          | Like `lib.page`, for re-encrypting |
| `reseal` | mutation | `{ id, from, payload }`       | Like `lib.reseal`                  |
| `record` | mutation |                               | Used by `recordDeliveryEvents`     |

Events that match no email are dropped after an hour.

## Testing

```ts
import { convexTest } from "convex-test";
import component from "@sarant/cloudflare-email-component/test";

const t = convexTest(schema, modules);
component.register(t);
```

Mock `fetch` for anything that calls Cloudflare. The component reads its `env`
from `process.env` under `convex-test`, so `vi.stubEnv` sets it. `t.fetch` only
reaches the app's own routes, so call your `onReceive` and `onEvents` handlers
directly.

## Example

[example/convex](../example/convex) is a working app that uses all of this:
sending through the bound credentials, the `onReceive` and `onEvents` handlers,
and an inbox with threaded replies.
