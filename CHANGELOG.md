# Changelog

## Unreleased

- The example is now a full inbox: a React app in `example/`, laid out like
  shadcn/ui's mail example, with Convex Auth sign-in limited to `INBOX_USERS`,
  every inbox in one list, search, compose and reply with attachments,
  read/unread, Archive and Trash, and live delivery status. **Add inbox** routes
  new addresses or a domain's catch-all to it, and can keep forwarding a copy to
  where the mail went before. It replaces the unauthenticated `/inbox` page.
  This change is to the example only.

Fixes:

- `setUpDeliveryEvents` no longer deletes a Worker it didn't upload. Running it
  again for a domain that was already set up failed on the taken queue name, and
  its cleanup then deleted the Worker the working setup used, which stopped
  delivery events. A cleanup that fails also no longer hides why setup failed.
- `ruleFor` reads every page of a zone's routing rules, not just the first 50.
  Past 50, it missed an address's rule, so setup routed the address again.
- `ruleFor` throws when Cloudflare can't list the rules. It used to return
  `undefined`, the same as "no rule", so a failed lookup led to a second rule
  that never runs.
- A sent email is no longer recorded as failed because of the shape of
  Cloudflare's answer. A `null` list or a `message_id` that isn't text made the
  component's `send` action throw after the mail had gone out.
- `lib.markResult` does nothing for an email removed while it was sending,
  instead of throwing. `sendEmail` used to throw after the mail went out, so a
  caller that retried sent it twice.
- `lib.reseal` keeps the stored `error` when it's called without one. Before,
  resealing only the payload deleted the error.
- `lib.removeOwner` deletes at least one email a call. A `limit` of 0 deleted
  nothing and returned `true`, so a caller looping until `false` never finished.
- `listSuppressions` leaves out a filter set to `undefined`. It used to send the
  text "undefined", which matched nothing.
- The inbound Worker rejects a message the app turned away when forwarding it
  fails too. Before, nobody got the message and the sender wasn't told. Upload
  the Worker again with `uploadWorker` to pick this up.

Docs:

- The README and API docs said Cloudflare tries inbound mail again when your
  handler throws, or before one is set. It doesn't. Cloudflare answers the
  sending server with a permanent `521 5.3.0 Upstream error`, so the message
  bounces back to its sender. The docs now say so. Delivery events are tried
  again, as before.
- The docs now say how events are matched to emails: by Message-ID, with the
  angle brackets removed.

## 0.2.2

- First version published from GitHub Actions with trusted publishing, so npm
  shows its provenance. 0.2.1 was tagged but never reached npm, and its changes
  are in this version.

## 0.2.1

- Test files no longer ship in the package. One of them used `new Function`,
  which security scanners such as Socket flag as eval. The package drops from 82
  to 75 files.

## 0.2.0

Breaking:

- Setup, receiving and suppression helpers move to
  `@sarant/cloudflare-email-component/cloudflare`: `setUpDeliveryEvents`,
  `removeDeliveryEvents`, `uploadWorker`, `createRule`, `ruleFor`,
  `routingEnabled`, `removeInbound`, the suppression functions, `inboundWorker`
  and `eventsWorker`. Update their imports.
- `tokenStatus`, `accessOf`, `zoneNamesOf` and `sha256` are removed.

Other changes:

- The main entry is 60% smaller (4.1 kB minified), so apps that only send bundle
  less.
- The inbound route turns away an oversized message before reading it.
- The README covers addresses, headers, limits and trade-offs, with links to
  Cloudflare's docs.
- `CHANGELOG.md` ships in the npm package.

## 0.1.1

- First publish, as `@sarant/cloudflare-email-component`.
- Track delivery: `recordDeliveryEvents` stores Cloudflare's delivery events,
  and `setUpDeliveryEvents` creates the queue, Worker and subscription that send
  them.
- The component serves inbound mail and delivery events on its own routes. Mount
  it with `httpPrefix: "/email/"` and register handlers with `lib.setHandlers`.
- Credentials can be bound once in `app.use` through component env.
- `lib.list`, `lib.page`, `events.list` and `events.page` take `paginationOpts`.
- Needs `convex` 1.49 or later.

## 0.1.0

- Send, receive and store email through Cloudflare.

## 0.0.0

- Initial release.
