import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { Infer } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { vEmail } from "../component/schema.js";
import { sendThroughCloudflare } from "../component/send.js";

export * from "./cloudflare.js";
export { vEmail };

export type Email = Infer<typeof vEmail>;

type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runMutation">;

/**
 * Queues, sends and records one email. `seal` turns what gets stored into the
 * opaque string the component keeps, so encrypt there, or pass `(text) => text`
 * to store it as plain text. It sees the email and any error, never the token.
 * A send that dies midway is marked failed by the component 15 minutes later.
 */
export async function sendEmail(
  ctx: ActionCtx,
  component: ComponentApi,
  args: {
    owner: string;
    accountId: string;
    apiToken: string;
    email: Email;
    seal: (text: string) => string | Promise<string>;
  },
) {
  const { owner, accountId, apiToken, email, seal } = args;
  const emailId = await ctx.runMutation(component.lib.queue, {
    owner,
    // Attachments stay out, they'd run into the document size limit.
    payload: await seal(JSON.stringify({ ...email, attachments: [] })),
  });
  // Right here, not through `lib.send`: a component call caps its arguments at
  // 16 MiB, under Cloudflare's 25 MiB, and the token stays in the app's action.
  const result = await sendThroughCloudflare({ accountId, apiToken, email });
  const { error } = result;
  await ctx.runMutation(component.lib.markResult, {
    emailId,
    failed: error !== undefined,
    error: error && (await seal(error)),
    messageId: result.messageId,
  });
  return { emailId, ...result };
}

const statuses = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.deferred": "deferred",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.complained": "complained",
} as const;

/** What Cloudflare publishes for one recipient of one email. */
export type DeliveryEvent = {
  type: keyof typeof statuses;
  source?: { zoneId?: string; domain?: string };
  payload: {
    eventId: string;
    messageId: string;
    recipient: string;
    sender?: string;
    subject?: string;
    terminal?: boolean;
    delivery?: { status?: string; smtpResponse?: string };
    bounce?: { type?: "hard" | "soft"; reason?: string };
    failure?: { reason?: string };
    rejection?: { reason?: string; detail?: string };
    complaint?: { type?: string };
  };
  metadata?: { eventTimestamp?: string };
};

const isDeliveryEvent = (event: unknown): event is DeliveryEvent => {
  const { type, payload } = (event ?? {}) as Partial<DeliveryEvent>;
  return (
    typeof type === "string" &&
    type in statuses &&
    typeof payload?.eventId === "string" &&
    typeof payload.messageId === "string" &&
    typeof payload.recipient === "string"
  );
};

/** The events in a Worker's post. Anything else is left out, as Cloudflare may add new kinds. */
export const parseDeliveryEvents = (body: unknown[]) =>
  body.filter(isDeliveryEvent);

/** Cloudflare's advice for when to stop mailing an address: a complaint or a hard bounce. */
export const isUndeliverable = ({ type, payload }: DeliveryEvent) =>
  type === "cf.email.sending.message.complained" ||
  (type === "cf.email.sending.message.bounced" &&
    payload.bounce?.type === "hard");

/**
 * Stores events and updates the status of the emails they're about. Queues can deliver an
 * event twice, so act only on results where `isNew` is true. `seal` sees each event's
 * payload, which holds the recipient and subject.
 */
export async function recordDeliveryEvents(
  ctx: ActionCtx,
  component: ComponentApi,
  args: {
    owner: string;
    events: DeliveryEvent[];
    seal: (text: string) => string | Promise<string>;
  },
) {
  const { owner, events, seal } = args;
  const results = await ctx.runMutation(component.events.record, {
    owner,
    events: await Promise.all(
      events.map(async ({ type, payload, metadata }) => ({
        eventId: payload.eventId,
        messageId: payload.messageId,
        status: statuses[type],
        terminal: payload.terminal ?? false,
        at: Date.parse(metadata?.eventTimestamp ?? "") || Date.now(),
        payload: await seal(JSON.stringify(payload)),
      })),
    ),
  });
  return results.map((result, i) => ({ ...result, event: events[i]! }));
}
