import { v } from "convex/values";

const vAddress = v.union(
  v.string(),
  v.object({
    address: v.string(),
    name: v.optional(v.string()),
  }),
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

export const vReceiveHandler = v.function({
  fnType: "action",
  args: {
    raw: v.bytes(),
    envelopeFrom: v.optional(v.string()),
    envelopeTo: v.optional(v.string()),
  },
  returns: v.union(v.literal("accept"), v.literal("reject")),
});

export const vEventsHandler = v.function({
  fnType: "action",
  // Cloudflare may add fields, so these aren't checked beyond `parseDeliveryEvents`.
  args: { events: v.array(v.any()) },
  returns: v.null(),
});

export const vStatus = v.union(
  v.literal("queued"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("received"),
);

export const vDirection = v.union(v.literal("inbound"), v.literal("outbound"));

export const vSendResult = v.object({
  messageId: v.optional(v.string()),
  error: v.optional(v.string()),
  errorCode: v.optional(v.number()),
  httpStatus: v.optional(v.number()),
  delivered: v.optional(v.array(v.string())),
  queued: v.optional(v.array(v.string())),
  permanentBounces: v.optional(v.array(v.string())),
  suppressed: v.optional(v.array(v.string())),
});
