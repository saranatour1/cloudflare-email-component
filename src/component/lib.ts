// The component stores only opaque payloads, and the message and token reach send()
// as arguments from an action. Scheduled functions keep their arguments, so nothing
// here schedules with a token or a message.
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  action,
  env,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { deliveryOf, messageIdKey, removeEventsOf } from "./events.js";
import schema, { vEmail, vEventsHandler, vReceiveHandler } from "./schema.js";
import { sendThroughCloudflare } from "./send.js";

const emailDoc = schema.doc("emails");
const direction = v.union(v.literal("inbound"), v.literal("outbound"));

// Past the 10 minutes an action can run, so the send can't still be going.
const stuckAfterMs = 15 * 60 * 1000;

export const queue = mutation({
  args: { owner: v.string(), payload: v.string() },
  returns: v.id("emails"),
  handler: async (ctx, { owner, payload }) => {
    const emailId = await ctx.db.insert("emails", {
      owner,
      payload,
      direction: "outbound",
      status: "queued",
    });
    await ctx.scheduler.runAfter(stuckAfterMs, internal.lib.expire, {
      emailId,
    });
    return emailId;
  },
});

export const expire = internalMutation({
  args: { emailId: v.id("emails") },
  returns: v.null(),
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get("emails", emailId);
    if (email?.status === "queued")
      await ctx.db.patch("emails", emailId, { status: "failed" });
    return null;
  },
});

/**
 * Prefer the client's `sendEmail`. Without `accountId` and `apiToken`, it uses what the app
 * bound in `app.use(cloudflareEmail, { env })`.
 */
export const send = action({
  args: {
    accountId: v.optional(v.string()),
    apiToken: v.optional(v.string()),
    email: vEmail,
  },
  returns: v.object({
    messageId: v.optional(v.string()),
    error: v.optional(v.string()),
    delivered: v.optional(v.array(v.string())),
    queued: v.optional(v.array(v.string())),
    permanentBounces: v.optional(v.array(v.string())),
    suppressed: v.optional(v.array(v.string())),
  }),
  handler: async (
    _ctx,
    {
      accountId = env.CLOUDFLARE_ACCOUNT_ID,
      apiToken = env.CLOUDFLARE_API_TOKEN,
      email,
    },
  ) =>
    accountId && apiToken
      ? await sendThroughCloudflare({ accountId, apiToken, email })
      : {
          error:
            "Pass accountId and apiToken, or bind CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in app.use",
        },
});

export const markResult = mutation({
  args: {
    emailId: v.id("emails"),
    failed: v.boolean(),
    payload: v.optional(v.string()),
    error: v.optional(v.string()),
    messageId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { emailId, failed, payload, error, messageId }) => {
    const email = await ctx.db.get("emails", emailId);
    if (!email) throw new Error("That email isn't here anymore");
    const key = messageId && messageIdKey(messageId);
    await ctx.db.patch("emails", emailId, {
      status: failed ? "failed" : "sent",
      error,
      ...(payload && { payload }),
      ...(key && {
        messageId: key,
        delivery: await deliveryOf(ctx, email.owner, key),
      }),
    });
    return null;
  },
});

export const receive = mutation({
  args: { owner: v.string(), payload: v.string() },
  returns: v.id("emails"),
  handler: (ctx, { owner, payload }) =>
    ctx.db.insert("emails", {
      owner,
      payload,
      direction: "inbound",
      status: "received",
    }),
});

export const get = query({
  args: { emailId: v.id("emails") },
  returns: v.union(v.null(), emailDoc),
  handler: (ctx, { emailId }) => ctx.db.get("emails", emailId),
});

export const list = query({
  args: {
    owner: v.string(),
    direction,
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(emailDoc),
  handler: (ctx, { owner, direction, paginationOpts }) =>
    ctx.db
      .query("emails")
      .withIndex("by_owner_and_direction", (q) =>
        q.eq("owner", owner).eq("direction", direction),
      )
      .order("desc")
      .paginate(paginationOpts),
});

export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      _id: v.id("emails"),
      owner: v.string(),
      payload: v.string(),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db.query("emails").paginate(paginationOpts);
    // Named, since a page also carries fields this doesn't return.
    return {
      ...result,
      page: result.page.map(({ _id, owner, payload, error }) => ({
        _id,
        owner,
        payload,
        error,
      })),
    };
  },
});

export const reseal = mutation({
  args: {
    emailId: v.id("emails"),
    from: v.string(),
    payload: v.string(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { emailId, from, payload, error }) => {
    const email = await ctx.db.get("emails", emailId);
    if (email?.payload === from)
      await ctx.db.patch("emails", emailId, { payload, error });
    return null;
  },
});

export const remove = mutation({
  args: { emailId: v.id("emails"), owner: v.string() },
  returns: v.null(),
  handler: async (ctx, { emailId, owner }) => {
    const email = await ctx.db.get("emails", emailId);
    if (email?.owner !== owner) return null;
    if (email.messageId) await removeEventsOf(ctx, owner, email.messageId);
    await ctx.db.delete("emails", emailId);
    return null;
  },
});

export const removeOwner = mutation({
  args: { owner: v.string(), limit: v.optional(v.number()) },
  returns: v.boolean(),
  handler: async (ctx, { owner, limit = 500 }) => {
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_owner_and_direction", (q) => q.eq("owner", owner))
      .take(limit + 1);
    for (const email of emails.slice(0, limit))
      await ctx.db.delete("emails", email._id);
    const events = await ctx.db
      .query("deliveryEvents")
      .withIndex("by_owner_and_messageId", (q) => q.eq("owner", owner))
      .take(limit + 1);
    for (const event of events.slice(0, limit))
      await ctx.db.delete("deliveryEvents", event._id);
    return emails.length > limit || events.length > limit;
  },
});

/** Points the HTTP routes at the app's functions. Leaves out what isn't passed. */
export const setHandlers = mutation({
  args: {
    onReceive: v.optional(vReceiveHandler),
    onEvents: v.optional(vEventsHandler),
  },
  returns: v.null(),
  handler: async (ctx, handlers) => {
    const current = await ctx.db.query("handlers").first();
    if (current) await ctx.db.patch("handlers", current._id, handlers);
    else await ctx.db.insert("handlers", handlers);
    return null;
  },
});

export const handlers = internalQuery({
  args: {},
  returns: v.union(v.null(), schema.doc("handlers")),
  handler: (ctx) => ctx.db.query("handlers").first(),
});
