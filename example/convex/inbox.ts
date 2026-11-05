import { v } from "convex/values";
import PostalMime from "postal-mime";
import type { Email } from "@sarant/cloudflare-email-component";
import {
  createRule,
  routingEnabled,
  ruleFor,
  uploadWorker,
} from "@sarant/cloudflare-email-component/cloudflare";
import { internal } from "./_generated/api.js";
import { env, internalAction } from "./_generated/server.js";

export type Stored = {
  _id: string;
  _creationTime: number;
  direction: "inbound" | "outbound";
  status: string;
  payload: string;
  error?: string;
  messageId?: string;
  delivery?: string;
};

const maxPayloadBytes = 900 * 1024;

// shortcut: leaves entities like &amp; as they are, use a real converter to show
// HTML mail properly. Safe, as the inbox never treats the result as HTML.
const textOf = (html: string) =>
  html
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(br|\/p|\/div|\/tr|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim();

const addressOf = (address: Email["from"]) =>
  (typeof address === "string" ? address : address.address).toLowerCase();

export const messageIds = (text?: string | null) =>
  text?.match(/<[^<>\s]+>/g) ?? ([] as string[]);

// What's kept is what the app sealed, which here is plain JSON.
export const toMessage = (email: Stored) => {
  const common = {
    id: email._id,
    at: email._creationTime,
    direction: email.direction,
  };
  if (email.direction === "inbound") {
    const mail = JSON.parse(email.payload) as {
      from?: string | null;
      fromName?: string;
      replyTo?: string;
      to: string;
      subject?: string;
      text?: string;
      messageId?: string;
      inReplyTo?: string;
      references?: string;
      attachments?: string[];
    };
    return {
      ...common,
      direction: "inbound" as const,
      // The address it came in on is what makes it part of an inbox.
      inbox: mail.to.toLowerCase(),
      from: mail.from ?? "Unknown sender",
      fromName: mail.fromName,
      replyTo: [mail.replyTo ?? mail.from ?? ""],
      to: [mail.to],
      subject: mail.subject ?? "",
      text: mail.text ?? "",
      attachments: mail.attachments ?? [],
      messageId: messageIds(mail.messageId)[0],
      inReplyTo: messageIds(mail.inReplyTo),
      references: messageIds(mail.references),
    };
  }
  const mail = JSON.parse(email.payload) as Email;
  const to = [mail.to]
    .flat()
    .filter((a) => a !== undefined)
    .map(addressOf);
  return {
    ...common,
    direction: "outbound" as const,
    inbox: addressOf(mail.from),
    from: addressOf(mail.from),
    replyTo: to,
    to,
    subject: mail.subject,
    text: mail.text ?? mail.html ?? "",
    status: email.delivery ?? email.status,
    error: email.error,
    messageId: email.messageId && `<${email.messageId}>`,
    inReplyTo: messageIds(mail.headers?.["In-Reply-To"]),
    references: messageIds(mail.headers?.References),
  };
};

// Parses what the component's /email/inbound route hands over.
export const receive = internalAction({
  args: {
    raw: v.bytes(),
    envelopeFrom: v.optional(v.string()),
    envelopeTo: v.optional(v.string()),
  },
  returns: v.union(v.literal("accept"), v.literal("reject")),
  handler: async (ctx, { raw, envelopeFrom, envelopeTo }) => {
    // A message it can't parse is still kept, as a retry would fail the same way.
    const mail = await PostalMime.parse(raw).catch(() => undefined);
    // shortcut: plain text. Encrypt real mail. Attachments go to file storage below.
    const payload = JSON.stringify({
      // The envelope sender is often a bounce address, so prefer what the mail says.
      from: mail?.from?.address ?? envelopeFrom,
      fromName: mail?.from?.name,
      replyTo: mail?.replyTo?.[0]?.address,
      to: envelopeTo ?? "",
      subject: mail?.subject,
      text: mail
        ? (mail.text ?? textOf(mail.html ?? ""))
        : new TextDecoder().decode(raw),
      messageId: mail?.messageId,
      inReplyTo: mail?.inReplyTo,
      references: mail?.references,
      attachments: mail?.attachments.map((a) => a.filename ?? "Unnamed"),
    });
    // Retrying a message that can never fit in a document would fail forever.
    if (new TextEncoder().encode(payload).length > maxPayloadBytes)
      return "reject";
    const attachments = [];
    for (const a of mail?.attachments ?? []) {
      const blob = new Blob([a.content as BlobPart], { type: a.mimeType });
      attachments.push({
        filename: a.filename ?? "Unnamed",
        contentType: a.mimeType,
        size: blob.size,
        // ponytail: a failed mutation below orphans these, sweep `_storage` if that bites.
        storageId: await ctx.storage.store(blob),
      });
    }
    await ctx.runMutation(internal.mail.receive, { payload, attachments });
    return "accept";
  },
});

/** Run with every address that should be an inbox, and again to add more. */
export const setUpInbox = internalAction({
  args: { zoneId: v.string(), addresses: v.array(v.string()) },
  handler: async (ctx, { zoneId, addresses }) => {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = env.CLOUDFLARE_API_TOKEN;
    const secret = env.INBOUND_SECRET;
    if (!accountId || !apiToken || !secret) {
      throw new Error(
        "Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and INBOUND_SECRET.",
      );
    }
    const domain = addresses[0]?.split("@")[1];
    if (!domain) throw new Error("Pass at least one full address.");
    // Turning this on replaces the domain's MX records, so it's left to you.
    if ((await routingEnabled(zoneId, apiToken)) === false) {
      throw new Error(`Turn on Email Routing for ${domain} in the dashboard.`);
    }
    await ctx.runMutation(internal.example.connect, {});
    const worker = `email-inbox-${domain.replaceAll(".", "-")}`;
    await uploadWorker(accountId, apiToken, worker, {
      inboundUrl: `${env.CONVEX_SITE_URL}/email/inbound`,
      secret,
    });
    const rules = [];
    for (const address of addresses) {
      const existing = await ruleFor(zoneId, apiToken, address);
      rules.push(
        existing
          ? { address, alreadyRouted: true, ...existing }
          : {
              address,
              id: await createRule(zoneId, apiToken, address, worker),
            },
      );
    }
    return { worker, rules };
  },
});
