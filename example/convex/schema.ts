import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const vFolder = v.union(
  v.literal("inbox"),
  v.literal("archive"),
  v.literal("trash"),
);

export const vAttachment = v.object({
  filename: v.string(),
  contentType: v.string(),
  size: v.number(),
  storageId: v.id("_storage"),
});

// The component keeps each email. These tables are the app's index over them, so the
// whole mailbox pages in and read/folder state lives somewhere.
export default defineSchema({
  // Convex Auth keeps usernames and passwords in its own components.
  users: defineTable({
    // Only on users from Convex Auth v1. Drop it once those rows are deleted.
    email: v.optional(v.string()),
  }),
  threads: defineTable({
    // Our address the conversation is on.
    inbox: v.string(),
    subject: v.string(),
    // Who it's with, as of the latest message.
    with: v.string(),
    snippet: v.string(),
    lastAt: v.number(),
    folder: vFolder,
    unread: v.boolean(),
    // Whether we've written in it, which puts it under Sent.
    sent: v.boolean(),
    // What search looks in. Optional only for threads filed before search existed.
    search: v.optional(v.string()),
  })
    .index("by_folder_and_lastAt", ["folder", "lastAt"])
    .index("by_folder_and_unread", ["folder", "unread"])
    .index("by_inbox_and_folder_and_lastAt", ["inbox", "folder", "lastAt"])
    .index("by_sent_and_lastAt", ["sent", "lastAt"])
    .index("by_inbox_and_sent_and_lastAt", ["inbox", "sent", "lastAt"])
    .searchIndex("search_search", {
      searchField: "search",
      filterFields: ["folder", "inbox", "sent", "unread"],
    }),
  messages: defineTable({
    threadId: v.id("threads"),
    // The component's email, which holds the message itself.
    emailId: v.string(),
    // `<id@host>`, for threading the replies that name it.
    messageId: v.optional(v.string()),
    attachments: v.array(vAttachment),
  })
    .index("by_threadId", ["threadId"])
    .index("by_messageId", ["messageId"])
    .index("by_emailId", ["emailId"]),
  inboxes: defineTable({ address: v.string() }).index("by_address", [
    "address",
  ]),
  // The Cloudflare zone of each domain with an inbox, for adding more addresses.
  domains: defineTable({
    domain: v.string(),
    zoneId: v.string(),
    // Where the domain's Worker also forwards each email, if anywhere.
    forwardTo: v.optional(v.string()),
  }).index("by_domain", ["domain"]),
});
