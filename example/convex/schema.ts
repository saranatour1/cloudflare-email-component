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

export default defineSchema({
  users: defineTable({
    email: v.optional(v.string()),
  }),
  threads: defineTable({
    inbox: v.string(),
    subject: v.string(),
    with: v.string(),
    snippet: v.string(),
    lastAt: v.number(),
    folder: vFolder,
    unread: v.boolean(),
    sent: v.boolean(),
    search: v.optional(v.string()),
  })
    .index("by_folder_and_lastAt", ["folder", "lastAt"])
    .index("by_folder_and_unread_and_lastAt", ["folder", "unread", "lastAt"])
    .index("by_inbox_and_folder_and_lastAt", ["inbox", "folder", "lastAt"])
    .index("by_inbox_and_folder_and_unread_and_lastAt", [
      "inbox",
      "folder",
      "unread",
      "lastAt",
    ])
    .index("by_sent_and_lastAt", ["sent", "lastAt"])
    .index("by_sent_and_unread_and_lastAt", ["sent", "unread", "lastAt"])
    .index("by_inbox_and_sent_and_lastAt", ["inbox", "sent", "lastAt"])
    .index("by_inbox_and_sent_and_unread_and_lastAt", [
      "inbox",
      "sent",
      "unread",
      "lastAt",
    ])
    .searchIndex("search_search", {
      searchField: "search",
      filterFields: ["folder", "inbox", "sent", "unread"],
    }),
  messages: defineTable({
    threadId: v.id("threads"),
    emailId: v.string(),
    messageId: v.optional(v.string()),
    attachments: v.array(vAttachment),
  })
    .index("by_threadId", ["threadId"])
    .index("by_messageId", ["messageId"])
    .index("by_emailId", ["emailId"]),
  inboxes: defineTable({ address: v.string() }).index("by_address", [
    "address",
  ]),
  domains: defineTable({
    domain: v.string(),
    zoneId: v.string(),
    forwardTo: v.optional(v.string()),
  }).index("by_domain", ["domain"]),
});
