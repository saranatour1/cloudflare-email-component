import { httpRouter } from "convex/server";
import { internal } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { inboxPage } from "./inboxPage.js";

// /email/inbound and /email/events are the component's, mounted in convex.config.ts.
const http = httpRouter();

// shortcut: no sign-in, so anyone with this deployment's URL can read this mail and
// reply as your domain. Put your own auth in front of these routes before real use.
http.route({
  path: "/inbox",
  method: "GET",
  handler: httpAction(async () => {
    const nonce = crypto.randomUUID();
    return new Response(inboxPage(nonce), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // Mail is written by strangers. The page only shows it as text, and this
        // stops anything that gets past that from running or calling out.
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    });
  }),
});

http.route({
  path: "/inbox/threads",
  method: "GET",
  handler: httpAction(async (ctx) =>
    Response.json(await ctx.runAction(internal.inbox.threads, {}), {
      headers: { "Cache-Control": "no-store" },
    }),
  ),
});

http.route({
  path: "/inbox/reply",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = (await req.json().catch(() => null)) as {
      emailId?: unknown;
      text?: unknown;
    } | null;
    const { emailId, text } = body ?? {};
    if (typeof emailId !== "string" || typeof text !== "string" || !text.trim())
      return new Response("Expected an emailId and some text", { status: 400 });
    return Response.json(
      await ctx.runAction(internal.inbox.reply, { emailId, text }),
    );
  }),
});

export default http;
