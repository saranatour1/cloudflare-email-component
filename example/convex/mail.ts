import { paginationOptsValidator } from "convex/server";
import { ConvexError, type Infer, v } from "convex/values";
import { toBase64, vEmail } from "@sarant/cloudflare-email-component";
import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server.js";
import { currentUser, requireUser } from "./auth.js";
import { deliver } from "./example.js";
import { toMessage } from "./inbox.js";
import { vAttachment, vFolder } from "./schema.js";

const owner = "example";

/** Adds one of the component's emails to the mailbox. Doing it twice is harmless. */
const file = async (
  ctx: MutationCtx,
  emailId: string,
  attachments: Infer<typeof vAttachment>[] = [],
) => {
  const known = await ctx.db
    .query("messages")
    .withIndex("by_emailId", (q) => q.eq("emailId", emailId))
    .unique();
  if (known) return known.threadId;
  const email = await ctx.runQuery(components.cloudflareEmail.lib.get, {
    emailId,
  });
  if (email?.owner !== owner) return null;
  const m = toMessage(email);
  const inbound = m.direction === "inbound";

  // A reply names what it answers, so the conversation is whichever we know first.
  let threadId: Id<"threads"> | undefined;
  for (const key of [...m.inReplyTo, ...m.references.toReversed()]) {
    const parent = await ctx.db
      .query("messages")
      .withIndex("by_messageId", (q) => q.eq("messageId", key))
      .first();
    if ((threadId = parent?.threadId)) break;
  }
  const latest = {
    with: m.direction === "inbound" ? m.fromName || m.from : m.to.join(", "),
    snippet: m.text.replace(/\s+/g, " ").trim().slice(0, 160),
    lastAt: m.at,
  };
  const thread = threadId && (await ctx.db.get("threads", threadId));
  if (thread) {
    await ctx.db.patch("threads", thread._id, {
      ...(m.at >= thread.lastAt && latest),
      unread: thread.unread || inbound,
      sent: thread.sent || !inbound,
      // An answer brings an archived conversation back. Trash stays trash.
      ...(inbound && thread.folder === "archive" && { folder: "inbox" }),
    });
  } else {
    threadId = await ctx.db.insert("threads", {
      inbox: m.inbox,
      subject: m.subject,
      ...latest,
      // Something we started waits under Sent until they answer.
      folder: inbound ? "inbox" : "archive",
      unread: inbound,
      sent: !inbound,
    });
  }
  await ctx.db.insert("messages", {
    threadId: threadId!,
    emailId,
    messageId: m.messageId,
    attachments,
  });
  const inbox = await ctx.db
    .query("inboxes")
    .withIndex("by_address", (q) => q.eq("address", m.inbox))
    .unique();
  if (!inbox) await ctx.db.insert("inboxes", { address: m.inbox });
  return threadId!;
};

export const receive = internalMutation({
  args: { payload: v.string(), attachments: v.array(vAttachment) },
  handler: async (ctx, { payload, attachments }) => {
    const emailId = await ctx.runMutation(
      components.cloudflareEmail.lib.receive,
      { owner, payload },
    );
    await file(ctx, emailId, attachments);
  },
});

export const fileSent = internalMutation({
  args: { emailId: v.string(), attachments: v.optional(v.array(vAttachment)) },
  handler: (ctx, { emailId, attachments }) => file(ctx, emailId, attachments),
});

// --- What the inbox page calls. Every one checks who's asking first. ---

export const me = query({
  args: {},
  // Null rather than throwing, so the page can say why there's no mail.
  handler: (ctx) => currentUser(ctx),
});

export const inboxes = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return (await ctx.db.query("inboxes").take(100)).map((i) => i.address);
  },
});

export const threads = query({
  args: {
    view: v.union(vFolder, v.literal("sent")),
    inbox: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { view, inbox, paginationOpts }) => {
    await requireUser(ctx);
    const threads = ctx.db.query("threads");
    const ordered =
      view === "sent"
        ? inbox
          ? threads.withIndex("by_inbox_and_sent_and_lastAt", (q) =>
              q.eq("inbox", inbox).eq("sent", true),
            )
          : threads.withIndex("by_sent_and_lastAt", (q) => q.eq("sent", true))
        : inbox
          ? threads.withIndex("by_inbox_and_folder_and_lastAt", (q) =>
              q.eq("inbox", inbox).eq("folder", view),
            )
          : threads.withIndex("by_folder_and_lastAt", (q) =>
              q.eq("folder", view),
            );
    return await ordered.order("desc").paginate(paginationOpts);
  },
});

export const thread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    await requireUser(ctx);
    const thread = await ctx.db.get("threads", threadId);
    if (!thread) return null;
    // ponytail: the first 200 messages, page them if a conversation ever runs longer.
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .take(200);
    const messages = await Promise.all(
      rows.map(async (row) => {
        const email = await ctx.runQuery(components.cloudflareEmail.lib.get, {
          emailId: row.emailId,
        });
        if (!email) return null;
        return {
          ...toMessage(email),
          attachments: await Promise.all(
            row.attachments.map(async (a) => ({
              ...a,
              url: await ctx.storage.getUrl(a.storageId),
            })),
          ),
        };
      }),
    );
    return {
      ...thread,
      messages: messages.filter((m) => m !== null).sort((a, b) => a.at - b.at),
    };
  },
});

// Its own query, as each one makes a paginated call into the component.
export const deliveries = query({
  args: { emailId: v.string() },
  handler: async (ctx, { emailId }) => {
    await requireUser(ctx);
    const { page } = await ctx.runQuery(
      components.cloudflareEmail.events.list,
      {
        emailId,
        paginationOpts: { numItems: 20, cursor: null },
      },
    );
    return page.map(({ status, at, payload }) => {
      const event = JSON.parse(payload) as {
        recipient?: string;
        delivery?: { smtpResponse?: string };
        bounce?: { reason?: string };
      };
      return {
        status,
        at,
        recipient: event.recipient,
        detail: event.bounce?.reason ?? event.delivery?.smtpResponse,
      };
    });
  },
});

export const setUnread = mutation({
  args: { threadId: v.id("threads"), unread: v.boolean() },
  handler: async (ctx, { threadId, unread }) => {
    await requireUser(ctx);
    await ctx.db.patch("threads", threadId, { unread });
  },
});

export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Unread conversations in the Inbox, counted up to 100. */
export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    // ponytail: reads up to 100 rows to count, keep a counter if the badge should go higher.
    const unread = await ctx.db
      .query("threads")
      .withIndex("by_folder_and_unread", (q) =>
        q.eq("folder", "inbox").eq("unread", true),
      )
      .take(100);
    return unread.length;
  },
});

export const move = mutation({
  args: { threadId: v.id("threads"), folder: vFolder },
  handler: async (ctx, { threadId, folder }) => {
    await requireUser(ctx);
    await ctx.db.patch("threads", threadId, { folder });
  },
});

export const allowed = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return null;
  },
});

// What the page uploads to send: a file in storage, named.
const vUpload = vAttachment.omit("size");

// ponytail: the email, attachments in base64 included, goes to the component's send
// action as one argument, which Convex caps at 16 MiB. Send straight to Cloudflare with
// `accountId`/`apiToken` in `sendEmail` to reach its 25 MiB limit.
const maxAttachmentBytes = 10 * 1024 * 1024;

const send = async (
  ctx: ActionCtx,
  email: Infer<typeof vEmail>,
  uploads: Infer<typeof vUpload>[] = [],
): Promise<{ threadId: Id<"threads"> | null; error?: string }> => {
  if (uploads.length > 32) throw new ConvexError("Attach 32 files at most.");
  const files = await Promise.all(
    uploads.map(async (upload) => {
      const blob = await ctx.storage.get(upload.storageId);
      if (!blob) throw new ConvexError(`${upload.filename} didn't upload.`);
      return { ...upload, blob };
    }),
  );
  if (files.reduce((n, f) => n + f.blob.size, 0) > maxAttachmentBytes)
    throw new ConvexError("Attachments can be 10 MB at most, all together.");
  const sent = await deliver(ctx, {
    ...email,
    ...(files.length > 0 && {
      attachments: await Promise.all(
        files.map(async ({ blob, filename, contentType }) => ({
          content: toBase64(await blob.arrayBuffer()),
          filename,
          type: contentType || "application/octet-stream",
          disposition: "attachment" as const,
        })),
      ),
    }),
  });
  // Failed sends are filed too, so you can see them and try again.
  const threadId: Id<"threads"> | null = await ctx.runMutation(
    internal.mail.fileSent,
    {
      emailId: sent.emailId,
      attachments: files.map(({ blob, ...upload }) => ({
        ...upload,
        size: blob.size,
      })),
    },
  );
  return { threadId, error: sent.error };
};

export const reply = action({
  args: {
    emailId: v.string(),
    text: v.string(),
    attachments: v.optional(v.array(vUpload)),
  },
  handler: async (ctx, { emailId, text, attachments }) => {
    await ctx.runQuery(internal.mail.allowed, {});
    if (!text.trim()) throw new ConvexError("Write something first.");
    const original = await ctx.runQuery(components.cloudflareEmail.lib.get, {
      emailId,
    });
    if (original?.owner !== owner)
      throw new ConvexError("That email isn't here anymore.");
    const { inbox, replyTo, subject, messageId, references } =
      toMessage(original);
    // A send that failed has no ID, so its retry answers what it was answering.
    const chain = messageId ? [...references, messageId] : references;
    return await send(
      ctx,
      {
        from: inbox,
        to: replyTo,
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        text,
        ...(chain.length > 0 && {
          headers: {
            "In-Reply-To": chain.at(-1)!,
            // Cloudflare caps a header at 2,048 bytes. Threading needs the first and latest.
            References: (chain.length > 10
              ? [chain[0], ...chain.slice(-9)]
              : chain
            ).join(" "),
          },
        }),
      },
      attachments,
    );
  },
});

export const compose = action({
  args: {
    from: v.string(),
    to: v.array(v.string()),
    subject: v.string(),
    text: v.string(),
    attachments: v.optional(v.array(vUpload)),
  },
  handler: async (ctx, { from, to, subject, text, attachments }) => {
    await ctx.runQuery(internal.mail.allowed, {});
    if (to.length === 0) throw new ConvexError("Who's it to?");
    return await send(ctx, { from, to, subject, text }, attachments);
  },
});

/** Files mail the component got before this index existed. Run once; reruns are harmless. */
export const backfill = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    // Oldest first, so a reply finds the conversation it belongs to.
    const { page, isDone, continueCursor } = await ctx.runQuery(
      components.cloudflareEmail.lib.page,
      { paginationOpts: { numItems: 100, cursor: cursor ?? null } },
    );
    for (const email of page)
      if (email.owner === owner)
        await ctx.runMutation(internal.mail.fileSent, { emailId: email._id });
    if (!isDone)
      await ctx.scheduler.runAfter(0, internal.mail.backfill, {
        cursor: continueCursor,
      });
  },
});
