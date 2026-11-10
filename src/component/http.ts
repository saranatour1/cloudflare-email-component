// Served at /email/inbound and /email/events once the app mounts the component with
// httpPrefix "/email/". Each checks its Worker's secret, then hands the request to the
// app's handler from `setHandlers`.
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { type ActionCtx, env, httpAction } from "./_generated/server.js";
import { parseDeliveryEvents } from "./deliveryEvents.js";

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const maxMessageBytes = 15 * 1024 * 1024;
const reply = (status: number, text?: string) =>
  new Response(text ?? null, { status });

const authorized = async (req: Request, secret: string | undefined) => {
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer /, "");
  return (
    !!secret && !!bearer && (await sha256(bearer)) === (await sha256(secret))
  );
};

const http = httpRouter();

const route = <K extends "onReceive" | "onEvents">(
  path: string,
  secret: "INBOUND_SECRET" | "EVENTS_SECRET",
  key: K,
  run: (
    ctx: ActionCtx,
    req: Request,
    handler: NonNullable<Doc<"handlers">[K]>,
  ) => Promise<Response>,
) =>
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, req) => {
      if (!(await authorized(req, env[secret])))
        return reply(401, "Unauthorized");
      const handler = (await ctx.runQuery(internal.lib.handlers, {}))?.[key];
      // Queues tries events again. Mail isn't tried again: it bounces to its sender.
      if (!handler) return reply(503, `No ${key} handler set`);
      return run(ctx, req, handler);
    }),
  });

// 403 turns the message away with our own reason. Any other failure makes the
// Worker throw, which Cloudflare answers with a permanent 521: the mail bounces.
route(
  "/inbound",
  "INBOUND_SECRET",
  "onReceive",
  async (ctx, req, onReceive) => {
    if (Number(req.headers.get("Content-Length")) > maxMessageBytes)
      return reply(403, "Message too large");
    const raw = await req.arrayBuffer();
    if (raw.byteLength > maxMessageBytes)
      return reply(403, "Message too large");
    const verdict = await ctx.runAction(onReceive, {
      raw,
      envelopeFrom: req.headers.get("X-Envelope-From") ?? undefined,
      envelopeTo: req.headers.get("X-Envelope-To") ?? undefined,
    });
    return verdict === "accept" ? reply(204) : reply(403, "Rejected");
  },
);

// Any failure makes Queues retry the batch five times, then park it in the dead letter queue.
route("/events", "EVENTS_SECRET", "onEvents", async (ctx, req, onEvents) => {
  const body: unknown = await req.json().catch(() => null);
  if (!Array.isArray(body)) return reply(400, "Expected a list of events");
  await ctx.runAction(onEvents, { events: parseDeliveryEvents(body) });
  return reply(204);
});

export default http;
