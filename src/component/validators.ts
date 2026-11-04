import { v } from "convex/values";

const vAddress = v.union(
  v.string(),
  v.object({
    address: v.string(),
    name: v.optional(v.string()),
    imageId: v.string().optional(),
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

/** Takes the raw MIME the inbound Worker posts. "reject" turns the message away. */
export const vReceiveHandler = v.function({
  fnType: "action",
  args: {
    raw: v.bytes(),
    envelopeFrom: v.optional(v.string()),
    envelopeTo: v.optional(v.string()),
  },
  returns: v.union(v.literal("accept"), v.literal("reject")),
});

/** Takes a batch of delivery events. Queues can deliver one twice. */
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

export type BodyResponse = {
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
