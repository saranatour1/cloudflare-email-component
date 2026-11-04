import { v } from "convex/values";
import PostalMime from "postal-mime";
import type { Email } from "@sarant/cloudflare-email-component";
import {
  createRule,
  routingEnabled,
  ruleFor,
  uploadWorker,
} from "@sarant/cloudflare-email-component/cloudflare";
import { components, internal } from "./_generated/api.js";
import { env, internalAction } from "./_generated/server.js";
import { deliver } from "./example.js";

type Stored = {
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

const messageIds = (text?: string | null) =>
  text?.match(/<[^<>\s]+>/g) ?? ([] as string[]);

// What's kept is what the app sealed, which here is plain JSON.
const toMessage = (email: Stored) => {
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
      references?: string;
      attachments?: string[];
    };
    return {
      ...common,
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
    inbox: addressOf(mail.from),
    from: addressOf(mail.from),
    replyTo: to,
    to,
    subject: mail.subject,
    text: mail.text ?? mail.html ?? "",
    status: email.delivery ?? email.status,
    error: email.error,
    messageId: email.messageId && `<${email.messageId}>`,
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
    // shortcut: plain text, without attachments. Encrypt real mail, and put its
    // attachments in `ctx.storage`.
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
      references: mail?.references,
      attachments: mail?.attachments.map((a) => a.filename ?? "Unnamed"),
    });
    // Retrying a message that can never fit in a document would fail forever.
    if (new TextEncoder().encode(payload).length > maxPayloadBytes)
      return "reject";
    await ctx.runMutation(components.cloudflareEmail.lib.receive, {
      owner: "example",
      payload,
    });
    return "accept";
  },
});

// An action, as a query can make only one paginated call and this makes two.
export const threads = internalAction({
  args: {},
  handler: async (ctx) => {
    const newest = async (direction: "inbound" | "outbound") =>
      // shortcut: the newest 50 each way, page on with continueCursor for a real mailbox.
      (
        await ctx.runQuery(components.cloudflareEmail.lib.list, {
          owner: "example",
          direction,
          paginationOpts: { numItems: 50, cursor: null },
        })
      ).page;
    const [inbound, outbound] = await Promise.all([
      newest("inbound"),
      newest("outbound"),
    ]);
    // shortcut: one query per sent email, fine for 50, keep a summary per email past that.
    const historyOf = async (emailId: string) =>
      (
        await ctx.runQuery(components.cloudflareEmail.events.list, {
          emailId,
          paginationOpts: { numItems: 20, cursor: null },
        })
      ).page
        .map(({ status, at, payload }) => {
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
        })
        .sort((a, b) => a.at - b.at);
    const sent = await Promise.all(
      outbound.map(async (email) => ({
        ...toMessage(email),
        events: email.messageId ? await historyOf(email._id) : [],
      })),
    );
    const messages = [...inbound.map(toMessage), ...sent].sort(
      (a, b) => a.at - b.at,
    );
    const byRoot = new Map<string, typeof messages>();
    for (const message of messages) {
      // Every reply names the message that started its thread first.
      const root = message.references[0] ?? message.messageId ?? message.id;
      byRoot.set(root, [...(byRoot.get(root) ?? []), message]);
    }
    return [...byRoot.values()].sort((a, b) => b.at(-1)!.at - a.at(-1)!.at);
  },
});

export const reply = internalAction({
  args: { emailId: v.string(), text: v.string() },
  handler: async (ctx, { emailId, text }) => {
    const original = await ctx.runQuery(components.cloudflareEmail.lib.get, {
      emailId,
    });
    if (original?.owner !== "example")
      throw new Error("That email isn't here anymore");
    const { inbox, replyTo, subject, messageId, references } =
      toMessage(original);
    // A send that failed has no ID, so its retry answers what it was answering.
    const chain = messageId ? [...references, messageId] : references;
    return await deliver(ctx, {
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
    });
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
