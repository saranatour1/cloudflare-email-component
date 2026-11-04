import { createFunctionHandle, paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  type Email,
  isUndeliverable,
  parseDeliveryEvents,
  recordDeliveryEvents,
  sendEmail,
  vEmail,
} from "@sarant/cloudflare-email-component";
import { setUpDeliveryEvents } from "@sarant/cloudflare-email-component/cloudflare";
import { components, internal } from "./_generated/api.js";
import {
  type ActionCtx,
  env,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";

/** Check who's asking before calling this, or it's an open mail relay. */
export const deliver = async (ctx: ActionCtx, email: Email) =>
  // The component sends with the credentials bound in convex.config.ts.
  await sendEmail(ctx, components.cloudflareEmail, {
    owner: "example",
    email,
    // shortcut: stored as plain text, encrypt here before sending real mail.
    seal: (text) => text,
  });

// Internal, so only the CLI, the dashboard or your own functions can call them.
// A public action here would be an open mail relay: authorize the caller first.
export const send = internalAction({
  args: { email: vEmail },
  handler: (ctx, { email }) => deliver(ctx, email),
});

export const list = internalQuery({
  args: {
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    paginationOpts: paginationOptsValidator,
  },
  handler: (ctx, { direction, paginationOpts }) =>
    ctx.runQuery(components.cloudflareEmail.lib.list, {
      owner: "example",
      direction,
      paginationOpts,
    }),
});

export const deliveryEvents = internalQuery({
  args: { emailId: v.string(), paginationOpts: paginationOptsValidator },
  handler: (ctx, args) =>
    ctx.runQuery(components.cloudflareEmail.events.list, args),
});

/** Hands the component's /email routes to this app. Run once, or by the setUp actions. */
export const connect = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.cloudflareEmail.lib.setHandlers, {
      onReceive: await createFunctionHandle(internal.inbox.receive),
      onEvents: await createFunctionHandle(internal.example.onEvents),
    });
  },
});

// Queues can deliver an event twice, which `isNew` takes care of.
export const onEvents = internalAction({
  args: { events: v.array(v.any()) },
  returns: v.null(),
  handler: async (ctx, { events }) => {
    const results = await recordDeliveryEvents(
      ctx,
      components.cloudflareEmail,
      {
        owner: "example",
        events: parseDeliveryEvents(events),
        // shortcut: stored as plain text, encrypt here before keeping real mail.
        seal: (text) => text,
      },
    );
    for (const { event, isNew } of results)
      // Take event.payload.recipient off your own mailing lists here.
      if (isNew && isUndeliverable(event))
        console.log(`Stop mailing, from event ${event.payload.eventId}`);
    return null;
  },
});

/** Run once per sending domain. Keep what it returns for `removeDeliveryEvents`. */
export const setUpEvents = internalAction({
  args: { zoneId: v.string(), domain: v.string() },
  handler: async (ctx, { zoneId, domain }) => {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = env.CLOUDFLARE_API_TOKEN;
    const secret = env.EVENTS_SECRET;
    if (!accountId || !apiToken || !secret) {
      throw new Error(
        "Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and EVENTS_SECRET.",
      );
    }
    await ctx.runMutation(internal.example.connect, {});
    return await setUpDeliveryEvents(accountId, apiToken, {
      name: `email-events-${domain.replaceAll(".", "-")}`,
      zoneId,
      domain,
      eventsUrl: `${env.CONVEX_SITE_URL}/email/events`,
      secret,
    });
  },
});
