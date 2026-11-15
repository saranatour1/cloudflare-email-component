import type { Infer } from "convex/values";
import type { vEmail, vSendResult } from "./validators.js";

const retryWaitsMs = [1000, 3000];
const maxRecipients = 50;

export type CloudflareErrors = { code?: unknown; message?: string }[];

type BodyResponse = {
  success?: boolean;
  errors?: CloudflareErrors;
  result?: {
    message_id?: unknown;
    delivered?: unknown;
    queued?: unknown;
    permanent_bounces?: unknown;
    suppressed_recipients?: unknown;
  };
} | null;

// Cloudflare's own descriptions, by the message after this prefix:
// https://developers.cloudflare.com/email-service/api/send-emails/rest-api/#error-responses
const sendingError = "email.sending.error.";
const meanings = new Map([
  ["not_found", "Resource not found"],
  ["invalid_request_schema", "Invalid request format"],
  ["internal_server", "Internal server error"],
  ["not_implemented", "Operation not implemented"],
  ["throttled", "Rate limit exceeded"],
  ["authentication.upstream", "Authentication service temporarily unavailable"],
  ["authentication.unauthorized", "Missing or invalid API token"],
  ["authentication.forbidden", "Token lacks permission to send"],
  ["authentication.bad_token_type", "Wrong token type for this endpoint"],
  ["authentication.not_entitled", "Account not entitled to use Email Sending"],
  ["email.too_big", "Email exceeds size limit"],
  ["email.no_content_length", "Missing content length"],
  ["email.invalid", "Invalid email content"],
  ["email.sending_disabled", "Sending disabled for this zone or account"],
  ["email.account_suspended", "Email Sending is paused for the account"],
]);

export const cloudflareError = (
  httpStatus: number,
  body: { errors?: CloudflareErrors } | null,
) => {
  const errors = body?.errors ?? [];
  const text = errors
    .map(({ code, message = "" }) => {
      const meaning = meanings.get(message.replace(sendingError, ""));
      return (
        [code, message].filter(Boolean).join(" ") +
        (meaning ? `: ${meaning}` : "")
      );
    })
    .filter(Boolean)
    .join("; ");
  const code = errors[0]?.code;
  return {
    error: text
      ? `${text} (HTTP ${httpStatus})`
      : `Cloudflare answered HTTP ${httpStatus} with no error details`,
    ...(typeof code === "number" && { errorCode: code }),
    httpStatus,
  };
};

const addresses = (list: unknown) =>
  Array.isArray(list)
    ? list.filter((a): a is string => typeof a === "string")
    : undefined;

export const sendThroughCloudflare = async ({
  accountId,
  apiToken,
  email: { replyTo, ...email },
}: {
  accountId: string;
  apiToken: string;
  email: Infer<typeof vEmail>;
}): Promise<Infer<typeof vSendResult>> => {
  const recipients = [email.to, email.cc, email.bcc].flat().filter(Boolean);
  if (recipients.length === 0)
    return { error: "One of `to`, `cc` or `bcc` is required" };
  if (recipients.length > maxRecipients)
    return { error: `Cloudflare takes at most ${maxRecipients} recipients` };
  if (!email.text && !email.html)
    return { error: "One of `text` or `html` is required" };

  try {
    const post = () =>
      fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...email, reply_to: replyTo }),
        },
      );
    let res = await post();

    // 429 and 503 mean it never went out.
    for (const wait of retryWaitsMs) {
      if (res.status !== 429 && res.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      res = await post();
    }

    const body = (await res.json().catch(() => null)) as BodyResponse;

    if (!res.ok || !body?.success) return cloudflareError(res.status, body);

    const r = body.result ?? {};
    const outcome = {
      delivered: addresses(r.delivered),
      queued: addresses(r.queued),
      permanentBounces: addresses(r.permanent_bounces),
      suppressed: addresses(r.suppressed_recipients),
    };
    // Cloudflare can say success while refusing every address.
    const dropped = [
      ...(outcome.permanentBounces ?? []).map((a) => `${a} bounced`),
      ...(outcome.suppressed ?? []).map(
        (a) => `${a} is on your suppression list`,
      ),
    ];
    const accepted = outcome.delivered?.length || outcome.queued?.length;
    return dropped.length && !accepted
      ? { ...outcome, error: `Not delivered: ${dropped.join("; ")}` }
      : {
          ...outcome,
          messageId:
            typeof r.message_id === "string" ? r.message_id : undefined,
        };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
