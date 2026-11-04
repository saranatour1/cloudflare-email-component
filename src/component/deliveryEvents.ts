// Shared by the component's /events route and the client.

export const statuses = {
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
