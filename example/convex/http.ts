import { httpRouter } from "convex/server";
import {
  isUndeliverable,
  parseDeliveryEvents,
  recordDeliveryEvents,
  sha256,
} from "@saranatour1/cloudflare-email-component";
import { components } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";

const authorized = async (req: Request, secret: string | undefined) => {
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer /, "");
  return (
    !!secret && !!bearer && (await sha256(bearer)) === (await sha256(secret))
  );
};

const http = httpRouter();
const maxPayloadBytes = 900 * 1024;

// Called by the Worker from `uploadWorker`. A 403 turns the message away; any
// other failure makes Cloudflare try again later.
http.route({
  path: "/email/inbound",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!(await authorized(req, env.INBOUND_SECRET)))
      return new Response("Unauthorized", { status: 401 });
    // shortcut: the raw message as plain text. Parse and encrypt real mail, with
    // something like postal-mime, and put large parts in `ctx.storage`.
    const payload = JSON.stringify({
      from: req.headers.get("X-Envelope-From"),
      to: req.headers.get("X-Envelope-To"),
      raw: await req.text(),
    });
    // A failure here would have Cloudflare retry a message that can never fit in
    // a document, so turn it away.
    if (new TextEncoder().encode(payload).length > maxPayloadBytes)
      return new Response("Message too large", { status: 403 });
    await ctx.runMutation(components.cloudflareEmail.lib.receive, {
      owner: "example",
      payload,
    });
    return new Response(null, { status: 204 });
  }),
});

// Called by the Worker from `setUpDeliveryEvents`. Any failure makes Queues retry the
// batch, so this has to be safe to run twice, which `isNew` takes care of.
http.route({
  path: "/email/events",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!(await authorized(req, env.EVENTS_SECRET)))
      return new Response("Unauthorized", { status: 401 });
    const body: unknown = await req.json().catch(() => null);
    if (!Array.isArray(body))
      return new Response("Expected a list of events", { status: 400 });
    const results = await recordDeliveryEvents(
      ctx,
      components.cloudflareEmail,
      {
        owner: "example",
        events: parseDeliveryEvents(body),
        // shortcut: stored as plain text, encrypt here before keeping real mail.
        seal: (text) => text,
      },
    );
    for (const { event, isNew } of results)
      // Take event.payload.recipient off your own mailing lists here.
      if (isNew && isUndeliverable(event))
        console.log(`Stop mailing, from event ${event.payload.eventId}`);
    return new Response(null, { status: 204 });
  }),
});

export default http;
