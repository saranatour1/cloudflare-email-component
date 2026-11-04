import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vStatus,
  vDelivery,
  vEventsHandler,
  vReceiveHandler,
} from "./validators";

export default defineSchema({
  emails: defineTable({
    owner: v.string(),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    status: vStatus,
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
  // save the return functions here, doesn't work on runtime
  handlers: defineTable({
    onReceive: v.optional(vReceiveHandler),
    onEvents: v.optional(vEventsHandler),
  }),
});
