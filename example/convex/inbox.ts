import { ConvexError, v } from "convex/values";
import PostalMime from "postal-mime";
import type { Email } from "@sarant/cloudflare-email-component";
import {
  createRule,
  routingEnabled,
  ruleFor,
  uploadWorker,
} from "@sarant/cloudflare-email-component/cloudflare";
import { internal } from "./_generated/api.js";
import { type ActionCtx, env, internalAction } from "./_generated/server.js";

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

const convexDocumentBytes = 1024 * 1024;
const maxPayloadBytes = convexDocumentBytes - 124 * 1024;

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

export const receive = internalAction({
  args: {
    raw: v.bytes(),
    envelopeFrom: v.optional(v.string()),
    envelopeTo: v.optional(v.string()),
  },
  returns: v.union(v.literal("accept"), v.literal("reject")),
  handler: async (ctx, { raw, envelopeFrom, envelopeTo }) => {
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

export type Routed = {
  address: string;
  id: string;
  alreadyRouted?: true;
  forwardsTo?: string;
  copiedTo?: string;
};

const cloudflare = async (
  token: string,
  path: string,
  init?: { method: "PUT"; body: unknown },
) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init?.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init && JSON.stringify(init.body),
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: unknown;
    errors?: { message?: string }[];
  } | null;
  if (!res.ok || !body?.success)
    throw new ConvexError(
      `Cloudflare said "${body?.errors?.[0]?.message ?? `HTTP ${res.status}`}" for ${path}`,
    );
  return body.result;
};

type Rule = {
  enabled?: boolean;
  matchers?: { type?: string; value?: string }[];
  actions?: { type?: string; value?: string[] }[];
};

const isCatchAll = (address: string) => address.startsWith("*@");

const catchAllRule = async (zoneId: string, token: string, worker: string) => {
  const rule = (await cloudflare(
    token,
    `/zones/${zoneId}/email/routing/rules/catch_all`,
  )) as Rule;
  const action = rule.enabled !== false ? rule.actions?.[0] : undefined;
  if (
    !action ||
    action.type === "drop" ||
    (action.type === "worker" && action.value?.[0] === worker)
  )
    return undefined;
  return {
    id: "catch_all",
    forwardsTo: action.type === "forward" ? action.value?.[0] : undefined,
  };
};

const pointAtWorker = (
  zoneId: string,
  token: string,
  rule: { id: string; address: string },
  worker: string,
) =>
  cloudflare(token, `/zones/${zoneId}/email/routing/rules/${rule.id}`, {
    method: "PUT",
    body: {
      name: "Convex Cloudflare Email",
      enabled: true,
      matchers: isCatchAll(rule.address)
        ? [{ type: "all" }]
        : [{ type: "literal", field: "to", value: rule.address }],
      actions: [{ type: "worker", value: [worker] }],
    },
  });

export const routeAddresses = async (
  ctx: ActionCtx,
  zoneId: string,
  addresses: string[],
  { keepForwarding = false } = {},
): Promise<{ worker: string; rules: Routed[] }> => {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const secret = env.INBOUND_SECRET;
  if (!accountId || !apiToken || !secret) {
    throw new ConvexError(
      "Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and INBOUND_SECRET.",
    );
  }
  const domain = addresses[0]?.split("@")[1]?.toLowerCase();
  if (!domain) throw new ConvexError("Pass at least one full address.");
  // Turning this on replaces the domain's MX records, so it's left to you.
  if ((await routingEnabled(zoneId, apiToken)) === false) {
    throw new ConvexError(
      `Turn on Email Routing for ${domain} in the dashboard.`,
    );
  }
  const worker = `email-inbox-${domain.replaceAll(".", "-")}`;
  const existing = await Promise.all(
    addresses.map(async (address) => ({
      address,
      rule: isCatchAll(address)
        ? await catchAllRule(zoneId, apiToken, worker)
        : await ruleFor(zoneId, apiToken, address),
    })),
  );
  const known: { forwardTo?: string } | null = await ctx.runQuery(
    internal.mail.domainOf,
    { domain },
  );
  let forwardTo = known?.forwardTo;
  for (const { rule } of existing) {
    if (!keepForwarding || !rule?.forwardsTo) continue;
    if (forwardTo && forwardTo !== rule.forwardsTo)
      throw new ConvexError(
        `${domain} already copies its mail to ${forwardTo}, and can copy to one address only.`,
      );
    forwardTo = rule.forwardsTo;
  }
  await ctx.runMutation(internal.example.connect, {});
  await uploadWorker(accountId, apiToken, worker, {
    inboundUrl: `${env.CONVEX_SITE_URL}/email/inbound`,
    secret,
    forwardTo,
  });
  const rules: Routed[] = [];
  for (const { address, rule } of existing) {
    if (rule && keepForwarding && rule.forwardsTo) {
      await pointAtWorker(zoneId, apiToken, { id: rule.id, address }, worker);
      rules.push({ address, ...rule, copiedTo: rule.forwardsTo });
    } else if (rule) rules.push({ address, alreadyRouted: true, ...rule });
    else if (isCatchAll(address)) {
      await pointAtWorker(
        zoneId,
        apiToken,
        { id: "catch_all", address },
        worker,
      );
      rules.push({ address, id: "catch_all" });
    } else
      rules.push({
        address,
        id: await createRule(zoneId, apiToken, address, worker),
      });
  }
  await ctx.runMutation(internal.mail.noteRouted, {
    domain,
    zoneId,
    forwardTo,
    addresses: rules
      .filter((r) => !r.alreadyRouted && !isCatchAll(r.address))
      .map((r) => r.address),
  });
  return { worker, rules };
};

export const setUpInbox = internalAction({
  args: {
    zoneId: v.string(),
    addresses: v.array(v.string()),
    keepForwarding: v.optional(v.boolean()),
  },
  handler: (ctx, { zoneId, addresses, keepForwarding }) =>
    routeAddresses(ctx, zoneId, addresses, { keepForwarding }),
});

export const routingStatus = internalAction({
  args: { domain: v.string() },
  handler: async (ctx, { domain }) => {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CLOUDFLARE_API_TOKEN;
    const known = await ctx.runQuery(internal.mail.domainOf, { domain });
    if (!accountId || !token || !known)
      throw new ConvexError(
        `Set the Cloudflare settings and add an inbox on ${domain} first.`,
      );
    const get = (path: string) =>
      cloudflare(token, path).catch((e: unknown) =>
        e instanceof ConvexError ? String(e.data) : String(e),
      );
    const worker = `email-inbox-${domain.replaceAll(".", "-")}`;
    const rules = (await get(
      `/zones/${known.zoneId}/email/routing/rules?per_page=50`,
    )) as
      | {
          enabled?: boolean;
          matchers?: { type?: string; value?: string }[];
          actions?: { type?: string; value?: string[] }[];
        }[]
      | string;
    const settings = (await get(
      `/accounts/${accountId}/workers/scripts/${worker}/settings`,
    )) as
      | { bindings?: { name: string; type: string; text?: string }[] }
      | string;
    return {
      worker,
      rules:
        typeof rules === "string"
          ? rules
          : rules.map((r) => ({
              enabled: r.enabled,
              to: r.matchers
                ?.map((m) => (m.type === "all" ? "(catch-all)" : m.value))
                .join(", "),
              goesTo: r.actions
                ?.map((a) => `${a.type} ${(a.value ?? []).join(", ")}`)
                .join("; "),
            })),
      workerSettings:
        typeof settings === "string"
          ? settings
          : settings.bindings?.map(
              (b) =>
                `${b.name}: ${b.type === "plain_text" ? b.text : "(secret)"}`,
            ),
    };
  },
});
