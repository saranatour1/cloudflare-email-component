import {
  useSignInWithUsernamePassword,
  useSignUpWithUsernamePassword,
} from "@convex-dev/auth/methods/username-password/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useQuery,
} from "convex/react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mail } from "./mail";

export function App() {
  return (
    <>
      <AuthLoading>
        <Centered>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Centered>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Inbox />
      </Authenticated>
    </>
  );
}

const Centered = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-dvh items-center justify-center p-4">
    {children}
  </div>
);

function Inbox() {
  const { signOut } = useAuthActions();
  const me = useQuery(api.mail.me);
  if (me === undefined)
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Centered>
    );
  if (me === null)
    return (
      <Centered>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Not on the list</CardTitle>
            <CardDescription>
              Add your email to INBOX_USERS on the deployment, then reload.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          </CardContent>
        </Card>
      </Centered>
    );
  return <Mail me={me} />;
}

// What the sign-in and sign-up mutations answer with, in words.
const signInErrors: Record<string, string> = {
  USER_NOT_FOUND: "No account with that email. Sign up first.",
  INVALID_CREDENTIALS: "Wrong password.",
  USERNAME_TAKEN: "That email already has an account. Sign in instead.",
  RATE_LIMITED: "Too many tries. Wait a minute and try again.",
  PASSWORD_TOO_SHORT: "Use at least 8 characters.",
  PASSWORD_TOO_COMMON: "That password is too common.",
};

function SignIn() {
  const { signIn, pending: signingIn } = useSignInWithUsernamePassword(
    api.auth,
  );
  const { signUp, pending: signingUp } = useSignUpWithUsernamePassword(
    api.auth,
  );
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const credentials = {
      username: `${form.get("email") as string}`.trim().toLowerCase(),
      password: form.get("password") as string,
    };
    setError("");
    const result = await (flow === "signIn" ? signIn : signUp)(credentials);
    if (result.status === "error") {
      const { error } = result.userError;
      setError(signInErrors[error] ?? `Couldn't sign in (${error}).`);
    }
  };
  return (
    <Centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">
            {flow === "signIn" ? "Sign in" : "Create an account"}
          </CardTitle>
          <CardDescription>
            Only the emails in INBOX_USERS can read mail.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                minLength={8}
                autoComplete={
                  flow === "signIn" ? "current-password" : "new-password"
                }
                required
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button className="w-full" disabled={signingIn || signingUp}>
              {flow === "signIn" ? "Sign in" : "Sign up"}
            </Button>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}
            >
              {flow === "signIn"
                ? "First time? Sign up"
                : "Have an account? Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Centered>
  );
}
