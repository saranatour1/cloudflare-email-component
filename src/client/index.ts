import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { Infer } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { type DeliveryEvent, statuses } from "../component/deliveryEvents.js";
import { sendThroughCloudflare } from "../component/send.js";
import { vEmail } from "../component/validators.js";

export {
  type DeliveryEvent,
  parseDeliveryEvents,
} from "../component/deliveryEvents.js";
export { vEmail };

export type Email = Infer<typeof vEmail>;

type Ctx = GenericActionCtx<GenericDataModel>;
type Seal = (text: string) => string | Promise<string>;

export async function sendEmail(
  ctx: Pick<Ctx, "runMutation" | "runAction">,
  component: ComponentApi,
  {
    owner,
    accountId,
    apiToken,
    email,
    seal,
  }: {
    owner: string;
    accountId?: string;
    apiToken?: string;
    email: Email;
    seal: Seal;
  },
) {
  const emailId = await ctx.runMutation(component.lib.queue, {
    owner,
    payload: await seal(JSON.stringify({ ...email, attachments: [] })),
  });
  const result =
    accountId && apiToken
      ? await sendThroughCloudflare({ accountId, apiToken, email })
      : await ctx.runAction(component.lib.send, { email });
  await ctx.runMutation(component.lib.markResult, {
    emailId,
    failed: result.error !== undefined,
    error: result.error && (await seal(result.error)),
    messageId: result.messageId,
  });
  return { emailId, ...result };
}

export async function recordDeliveryEvents(
  ctx: Pick<Ctx, "runMutation">,
  component: ComponentApi,
  {
    owner,
    events,
    seal,
  }: { owner: string; events: DeliveryEvent[]; seal: Seal },
) {
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

export const isUndeliverable = ({ type, payload }: DeliveryEvent) =>
  type === "cf.email.sending.message.complained" ||
  (type === "cf.email.sending.message.bounced" &&
    payload.bounce?.type === "hard");

export const toBase64 = (bytes: ArrayBuffer) => {
  const all = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < all.length; i += 8192)
    binary += String.fromCharCode(...all.subarray(i, i + 8192));
  return btoa(binary);
};
