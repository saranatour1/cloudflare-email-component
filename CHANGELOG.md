# Changelog

## Unreleased

- The example is now a full inbox: a React app in `example/`, laid out like
  shadcn/ui's mail example, with Convex Auth sign-in limited to `INBOX_USERS`,
  every inbox in one list, search, compose and reply with attachments,
  read/unread, Archive and Trash, and live delivery status. **Add inbox** routes
  new addresses or a domain's catch-all to it, and can keep forwarding a copy to
  where the mail went before. It replaces the unauthenticated `/inbox` page. The
  package itself is unchanged.

Fixes:

- `setUpDeliveryEvents` no longer deletes a Worker it didn't upload. Running it
  again for a domain that was already set up failed on the taken queue name, and
  its cleanup then deleted the Worker the working setup used, which stopped
  delivery events. A cleanup that fails also no longer hides why setup failed.
- `ruleFor` reads every page of a zone's routing rules, not just the first 50.
  Past 50, it missed an address's rule, so setup routed the address again.
- `lib.reseal` keeps the stored `error` when it's called without one. Before,
  resealing only the payload deleted the error.
- `lib.markResult` does nothing for an email removed while it was sending,
  instead of throwing. `sendEmail` used to throw after the mail went out, so a
  caller that retried sent it twice.

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
