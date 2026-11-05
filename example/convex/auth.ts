import { getAuthUserId, setupConvexAuth } from "@convex-dev/auth/server";
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server";
import { ConvexError } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { env, type QueryCtx } from "./_generated/server.js";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

// The username is the email. Email+password sign-in would verify it, but only
// through Resend for now, so this inbox checks it against INBOX_USERS instead.
export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
  setupUsernamePassword(auth, {
    component: components.authPassword,
    usernameComponent: components.authUsername,
  }).attachUserCallbacks({ createUser: internal.users.create });

const allowed = (email: string | null) =>
  !!email &&
  (env.INBOX_USERS ?? "")
    .split(",")
    .some((user) => user.trim().toLowerCase() === email.toLowerCase());

/** The signed-in user's email, or null unless it's on INBOX_USERS. */
export const currentUser = async (ctx: QueryCtx) => {
  const userId = await getAuthUserId(ctx);
  const email =
    userId &&
    (await ctx.runQuery(components.authUsername.public.getUsername, {
      userId,
    }));
  return allowed(email) ? email : null;
};

/** Anyone can make an account, but only those on INBOX_USERS see any mail. */
export const requireUser = async (ctx: QueryCtx) => {
  const email = await currentUser(ctx);
  if (!email) throw new ConvexError("Not on INBOX_USERS.");
  return email;
};
