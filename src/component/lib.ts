// The component stores only opaque payloads, and the message and token reach send()
// as arguments from an action. Scheduled functions keep their arguments, so nothing
// here schedules with a token or a message.
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  action,
  internalMutation,
  mutation,
  query,
} from "./_generated/server.js";
import schema, { vEmail } from "./schema.js";

const emailDoc = schema.doc("emails");
const direction = v.union(v.literal("inbound"), v.literal("outbound"));

// Past the 10 minutes an action can run, so the send can't still be going.
const stuckAfterMs = 15 * 60 * 1000;
const retryWaitsMs = [1000, 3000];

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

// shortcut: retries only ride out a few seconds; schedule an app action with just the
// emailId, which reopens the sealed connection, if throttling lasts longer than that.
/** Sends through Cloudflare and returns its Message-ID if it gives one, or why it failed. Stores nothing. */
export const send = action({
  args: { accountId: v.string(), apiToken: v.string(), email: vEmail },
  returns: v.object({
    messageId: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (
    _ctx,
    { accountId, apiToken, email: { replyTo, ...email } },
  ) => {
    if (email.to.length === 0) return { error: "`to` must not be empty" };
    if (!email.text && !email.html)
      return { error: "One of `text` or `html` is required" };
    try {
      const post = () =>
        fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...email, reply_to: replyTo }),
          },
        );
      let res = await post();
      // 429 and 503 mean it never went out. Anything else, a thrown fetch included, may
      // have, and Cloudflare takes no idempotency key, so a retry could send it twice.
      for (const wait of retryWaitsMs) {
        if (res.status !== 429 && res.status !== 503) break;
        await new Promise((resolve) => setTimeout(resolve, wait));
        res = await post();
      }
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        errors?: { message: string }[];
        result?: {
          message_id?: string;
          delivered?: string[];
          queued?: string[];
          permanent_bounces?: string[];
          suppressed_recipients?: string[];
        };
      } | null;
      if (!res.ok || !body?.success)
        return {
          error:
            body?.errors?.map((e) => e.message).join("; ") ||
            `HTTP ${res.status}`,
        };
      // Cloudflare can say success while refusing every address.
      const { delivered, queued, permanent_bounces, suppressed_recipients } =
        body.result ?? {};
      const dropped = [
        ...(permanent_bounces ?? []),
        ...(suppressed_recipients ?? []),
      ];
      if (dropped.length && !delivered?.length && !queued?.length)
        return { error: `Not delivered to ${dropped.join(", ")}` };
      return { messageId: body.result?.message_id };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const markResult = mutation({
  args: {
    emailId: v.id("emails"),
    failed: v.boolean(),
    payload: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { emailId, failed, payload, error }) => {
    await ctx.db.patch("emails", emailId, {
      status: failed ? "failed" : "sent",
      error,
      ...(payload && { payload }),
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
  args: { owner: v.string(), direction, limit: v.optional(v.number()) },
  returns: v.array(emailDoc),
  handler: (ctx, { owner, direction, limit }) =>
    ctx.db
      .query("emails")
      .withIndex("by_owner_and_direction", (q) =>
        q.eq("owner", owner).eq("direction", direction),
      )
      .order("desc")
      .take(Math.min(limit ?? 50, 500)),
});

export const page = query({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(
      v.object({
        _id: v.id("emails"),
        owner: v.string(),
        payload: v.string(),
        error: v.optional(v.string()),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db
      .query("emails")
      .paginate({ cursor, numItems: 100 });
    // Named, since a page also carries fields this doesn't return.
    return {
      isDone: result.isDone,
      continueCursor: result.continueCursor,
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
    if (email?.owner === owner) await ctx.db.delete("emails", emailId);
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
    return emails.length > limit;
  },
});
