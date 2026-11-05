import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import authPassword from "@convex-dev/auth/components/password/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";
import cloudflareEmail from "@sarant/cloudflare-email-component/convex.config.js";

const app = defineApp({
  env: {
    CLOUDFLARE_ACCOUNT_ID: v.optional(v.string()),
    CLOUDFLARE_API_TOKEN: v.optional(v.string()),
    INBOUND_SECRET: v.optional(v.string()),
    EVENTS_SECRET: v.optional(v.string()),
    // Comma-separated sign-in emails allowed into the inbox. Everyone else is turned away.
    INBOX_USERS: v.optional(v.string()),
    // Convex Auth's signing keys. See the README for making them.
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
  },
});
// Sign-in serves its routes, such as the JWKS, under /auth.
app.use(auth, {
  httpPrefix: "/auth",
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});
app.use(authPassword);
app.use(authUsername);
// By reference, so the component sees new values as soon as they're set. The prefix
// serves its routes at /email/inbound and /email/events.
app.use(cloudflareEmail, {
  httpPrefix: "/email/",
  env: {
    CLOUDFLARE_ACCOUNT_ID: app.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: app.env.CLOUDFLARE_API_TOKEN,
    INBOUND_SECRET: app.env.INBOUND_SECRET,
    EVENTS_SECRET: app.env.EVENTS_SECRET,
  },
});

export default app;
