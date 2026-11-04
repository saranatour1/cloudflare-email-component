import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  type DatabaseReader,
  type DatabaseWriter,
  internalMutation,
  mutation,
  query,
} from "./_generated/server.js";
import schema from "./schema.js";
import { vDelivery } from "./validators.js";

type Delivery = Infer<typeof vDelivery>;
type Reader = { db: DatabaseReader };
type Writer = { db: DatabaseWriter };

const unmatchedForMs = 60 * 60 * 1000;

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

export const messageIdKey = (messageId: string) =>
  messageId.trim().replace(/^<|>$/g, "");

const eventsOf = ({ db }: Reader, owner: string, messageId: string) =>
  db
    .query("deliveryEvents")
    .withIndex("by_owner_and_messageId", (q) =>
      q.eq("owner", owner).eq("messageId", messageId),
    );

const emailOf = ({ db }: Reader, owner: string, messageId: string) =>
  db
    .query("emails")
    .withIndex("by_owner_and_messageId", (q) =>
      q.eq("owner", owner).eq("messageId", messageId),
    )
    .first();

export const deliveryOf = async (
  ctx: Reader,
  owner: string,
  messageId: string,
) => {
  let delivery: Delivery | undefined;
  for await (const event of eventsOf(ctx, owner, messageId))
    delivery = worse(delivery, event.status);
  return delivery;
};

export const removeEventsOf = async (
  ctx: Writer,
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
      const email = await emailOf(ctx, owner, messageId);
      results.push({
        eventId: event.eventId,
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
    if (event && !(await emailOf(ctx, event.owner, event.messageId)))
      await ctx.db.delete("deliveryEvents", id);
    return null;
  },
});

export const list = query({
  args: { emailId: v.id("emails"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("deliveryEvents")),
  handler: async (ctx, { emailId, paginationOpts }) => {
    const email = await ctx.db.get("emails", emailId);
    if (!email?.messageId)
      return { page: [], isDone: true, continueCursor: "" };
    return await eventsOf(ctx, email.owner, email.messageId).paginate(
      paginationOpts,
    );
  },
});

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
