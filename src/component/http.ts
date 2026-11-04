// Mounted by the app with app.use(cloudflareEmail, { httpPrefix: "/email/" }), so these are
// /email/inbound and /email/events. Each checks its Worker's secret and hands what it was
// sent to the app's handler from `setHandlers`, as owners and sealing are the app's call.
import { httpRouter } from "convex/server";
import { sha256 } from "../client/cloudflare.js";
import { internal } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";
import { parseDeliveryEvents } from "./deliveryEvents.js";

const authorized = async (req: Request, secret: string | undefined) => {
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer /, "");
  return (
    !!secret && !!bearer && (await sha256(bearer)) === (await sha256(secret))
  );
};

// Under the 16 MiB a function argument can be, which is how the app gets it.
const maxMessageBytes = 15 * 1024 * 1024;

const http = httpRouter();

// A 403 turns the message away. Anything else that fails, including a 503 before the app
// sets a handler, has Cloudflare try again later.
http.route({
  path: "/inbound",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!(await authorized(req, env.INBOUND_SECRET)))
      return new Response("Unauthorized", { status: 401 });
    const onReceive = (await ctx.runQuery(internal.lib.handlers, {}))
      ?.onReceive;
    if (!onReceive)
      return new Response("No onReceive handler set", { status: 503 });
    const raw = await req.arrayBuffer();
    if (raw.byteLength > maxMessageBytes)
      return new Response("Message too large", { status: 403 });
    const verdict = await ctx.runAction(onReceive, {
      raw,
      envelopeFrom: req.headers.get("X-Envelope-From") ?? undefined,
      envelopeTo: req.headers.get("X-Envelope-To") ?? undefined,
    });
    return verdict === "accept"
      ? new Response(null, { status: 204 })
      : new Response("Rejected", { status: 403 });
  }),
});

// Any failure makes Queues retry the batch, five times, then park it in the dead letter queue.
http.route({
  path: "/events",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!(await authorized(req, env.EVENTS_SECRET)))
      return new Response("Unauthorized", { status: 401 });
    const body: unknown = await req.json().catch(() => null);
    if (!Array.isArray(body))
      return new Response("Expected a list of events", { status: 400 });
    const onEvents = (await ctx.runQuery(internal.lib.handlers, {}))?.onEvents;
    if (!onEvents)
      return new Response("No onEvents handler set", { status: 503 });
    await ctx.runAction(onEvents, { events: parseDeliveryEvents(body) });
    return new Response(null, { status: 204 });
  }),
});

export default http;
