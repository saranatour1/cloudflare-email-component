# Changelog

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
