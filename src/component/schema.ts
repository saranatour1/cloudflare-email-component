import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const vAddress = v.union(
  v.string(),
  v.object({ address: v.string(), name: v.optional(v.string()) }),
);
const vRecipients = v.union(vAddress, v.array(vAddress));

export const vEmail = v.object({
  from: vAddress,
  to: v.optional(vRecipients),
  cc: v.optional(vRecipients),
  bcc: v.optional(vRecipients),
  replyTo: v.optional(vAddress),
  subject: v.string(),
  text: v.optional(v.string()),
  html: v.optional(v.string()),
  attachments: v.optional(
    v.array(
      v.union(
        v.object({
          content: v.string(),
          filename: v.string(),
          type: v.string(),
          disposition: v.literal("attachment"),
        }),
        v.object({
          content: v.string(),
          filename: v.string(),
          type: v.string(),
          disposition: v.literal("inline"),
          content_id: v.string(),
        }),
      ),
    ),
  ),
  headers: v.optional(v.record(v.string(), v.string())),
});

export const vDelivery = v.union(
  v.literal("delivered"),
  v.literal("deferred"),
  v.literal("bounced"),
  v.literal("failed"),
  v.literal("rejected"),
  v.literal("complained"),
);

export default defineSchema({
  emails: defineTable({
    owner: v.string(),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    status: v.union(
      v.literal("queued"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("received"),
    ),
    payload: v.string(),
    error: v.optional(v.string()),
    messageId: v.optional(v.string()),
    delivery: v.optional(vDelivery),
  })
    .index("by_owner_and_direction", ["owner", "direction"])
    .index("by_owner_and_messageId", ["owner", "messageId"]),
  deliveryEvents: defineTable({
    owner: v.string(),
    eventId: v.string(),
    messageId: v.string(),
    status: vDelivery,
    terminal: v.boolean(),
    at: v.number(),
    payload: v.string(),
  })
    .index("by_owner_and_eventId", ["owner", "eventId"])
    .index("by_owner_and_messageId", ["owner", "messageId"]),
});
