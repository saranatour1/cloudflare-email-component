// What happens to mail after Cloudflare accepts it, from its event subscriptions. Like
// emails, an event's payload is opaque: it holds addresses and subjects, so the app seals it.
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import schema, { vDelivery } from "./schema.js";

type Delivery = Infer<typeof vDelivery>;

// An event can beat markResult here, or be for mail the component never saw.
const unmatchedForMs = 60 * 60 * 1000;

// An email's outcome is the worst of its recipients', which doesn't depend on the order
// events arrive in. Queues can deliver them out of order.
const severity: Record<Delivery, number> = {
  deferred: 0,
  delivered: 1,
  failed: 2,
  rejected: 2,
  bounced: 2,
  complained: 3,
};
const worse = (a: Delivery | undefined, b: Delivery) =>
  a && severity[a] > severity[b] ? a : b;

/** `<id@host>` from the send response and `id@host` are the same message. */
export const messageIdKey = (messageId: string) =>
  messageId.trim().replace(/^<|>$/g, "");

const eventsOf = (
  ctx: { db: MutationCtx["db"] },
  owner: string,
  messageId: string,
) =>
  ctx.db
    .query("deliveryEvents")
    .withIndex("by_owner_and_messageId", (q) =>
      q.eq("owner", owner).eq("messageId", messageId),
    );

/** For markResult, as events may already be waiting for this message. */
export const deliveryOf = async (
  ctx: { db: MutationCtx["db"] },
  owner: string,
  messageId: string,
) => {
  let delivery: Delivery | undefined;
  for await (const event of eventsOf(ctx, owner, messageId))
    delivery = worse(delivery, event.status);
  return delivery;
};

export const removeEventsOf = async (
  ctx: { db: MutationCtx["db"] },
  owner: string,
  messageId: string,
) => {
  for await (const event of eventsOf(ctx, owner, messageId))
    await ctx.db.delete("deliveryEvents", event._id);
};

export const record = mutation({
  args: {
    owner: v.string(),
    events: v.array(
      v.object({
        eventId: v.string(),
        messageId: v.string(),
        status: vDelivery,
        terminal: v.boolean(),
        at: v.number(),
        payload: v.string(),
      }),
    ),
  },
  returns: v.array(
    v.object({
      eventId: v.string(),
      isNew: v.boolean(),
      emailId: v.optional(v.id("emails")),
    }),
  ),
  handler: async (ctx, { owner, events }) => {
    const results = [];
    for (const event of events) {
      const messageId = messageIdKey(event.messageId);
      const seen = await ctx.db
        .query("deliveryEvents")
        .withIndex("by_owner_and_eventId", (q) =>
          q.eq("owner", owner).eq("eventId", event.eventId),
        )
        .first();
      // By owner too, so one tenant's Worker can't touch another's mail.
      const email = await ctx.db
        .query("emails")
        .withIndex("by_owner_and_messageId", (q) =>
          q.eq("owner", owner).eq("messageId", messageId),
        )
        .first();
      results.push({
        eventId: event.eventId,
        // Queues delivers at least once, so the app only acts on new ones.
        isNew: !seen,
        ...(email && { emailId: email._id }),
      });
      if (seen) continue;
      const id = await ctx.db.insert("deliveryEvents", {
        ...event,
        owner,
        messageId,
      });
      if (email)
        await ctx.db.patch("emails", email._id, {
          delivery: worse(email.delivery, event.status),
        });
      else
        await ctx.scheduler.runAfter(
          unmatchedForMs,
          internal.events.dropUnmatched,
          { id },
        );
    }
    return results;
  },
});

export const dropUnmatched = internalMutation({
  args: { id: v.id("deliveryEvents") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const event = await ctx.db.get("deliveryEvents", id);
    if (!event) return null;
    const email = await ctx.db
      .query("emails")
      .withIndex("by_owner_and_messageId", (q) =>
        q.eq("owner", event.owner).eq("messageId", event.messageId),
      )
      .first();
    if (!email) await ctx.db.delete("deliveryEvents", id);
    return null;
  },
});

export const list = query({
  args: { emailId: v.id("emails"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("deliveryEvents")),
  handler: async (ctx, { emailId, paginationOpts }) => {
    const email = await ctx.db.get("emails", emailId);
    const messageId = email?.messageId;
    if (!email || !messageId)
      return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("deliveryEvents")
      .withIndex("by_owner_and_messageId", (q) =>
        q.eq("owner", email.owner).eq("messageId", messageId),
      )
      .paginate(paginationOpts);
  },
});

/** With `reseal`, for re-encrypting payloads, the same as `lib.page` for emails. */
export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      _id: v.id("deliveryEvents"),
      owner: v.string(),
      payload: v.string(),
    }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db
      .query("deliveryEvents")
      .paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map(({ _id, owner, payload }) => ({
        _id,
        owner,
        payload,
      })),
    };
  },
});

export const reseal = mutation({
  args: { id: v.id("deliveryEvents"), from: v.string(), payload: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, from, payload }) => {
    const event = await ctx.db.get("deliveryEvents", id);
    if (event?.payload === from)
      await ctx.db.patch("deliveryEvents", id, { payload });
    return null;
  },
});
