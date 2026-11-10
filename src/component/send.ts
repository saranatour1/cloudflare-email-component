import type { Infer } from "convex/values";
import type { BodyResponse, vEmail } from "./validators";

const retryWaitsMs = [1000, 3000];
const maxRecipients = 50;

/** A list of addresses, or nothing if Cloudflare sent anything else, such as null. */
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
}): Promise<{
  messageId?: string;
  error?: string;
  delivered?: string[];
  queued?: string[];
  permanentBounces?: string[];
  suppressed?: string[];
}> => {
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

    if (!res.ok || !body?.success)
      return {
        error:
          body?.errors?.map((e) => e.message).join("; ") ||
          `HTTP ${res.status}`,
      };

    // The mail has gone out by now, so nothing in the answer's shape may throw here
    // or fail the `send` action's return validator: that would record it as failed.
    const r = body.result ?? {};
    const outcome = {
      delivered: addresses(r.delivered),
      queued: addresses(r.queued),
      permanentBounces: addresses(r.permanent_bounces),
      suppressed: addresses(r.suppressed_recipients),
    };
    // Cloudflare can say success while refusing every address.
    const dropped = [
      ...(outcome.permanentBounces ?? []),
      ...(outcome.suppressed ?? []),
    ];
    const accepted = outcome.delivered?.length || outcome.queued?.length;
    return dropped.length && !accepted
      ? { ...outcome, error: `Not delivered to ${dropped.join(", ")}` }
      : {
          ...outcome,
          messageId:
            typeof r.message_id === "string" ? r.message_id : undefined,
        };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
