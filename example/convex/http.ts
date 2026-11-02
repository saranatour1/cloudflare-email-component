import { httpRouter } from "convex/server";
import { sha256 } from "@saranatour1/cloudflare-email-component";
import { components } from "./_generated/api.js";
import { env, httpAction } from "./_generated/server.js";

const http = httpRouter();

// Called by the Worker from `uploadWorker`. A 403 turns the message away; any
// other failure makes Cloudflare try again later.
http.route({
  path: "/email/inbound",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const bearer = req.headers.get("Authorization")?.replace(/^Bearer /, "");
    const secret = env.INBOUND_SECRET;
    if (!secret || !bearer || (await sha256(bearer)) !== (await sha256(secret)))
      return new Response("Unauthorized", { status: 401 });
    await ctx.runMutation(components.cloudflareEmail.lib.receive, {
      owner: "example",
      // shortcut: the raw message as plain text, which fails above the 1 MB
      // document limit. Parse and encrypt it before keeping real mail.
      payload: JSON.stringify({
        from: req.headers.get("X-Envelope-From"),
        to: req.headers.get("X-Envelope-To"),
        raw: await req.text(),
      }),
    });
    return new Response(null, { status: 204 });
  }),
});

export default http;
