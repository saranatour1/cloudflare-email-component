import { httpRouter } from "convex/server";

// /email/inbound and /email/events are the cloudflare component's, and /auth is
// Convex Auth's, all mounted in convex.config.ts.
export default httpRouter();
