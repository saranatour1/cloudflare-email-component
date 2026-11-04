# Changelog

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
