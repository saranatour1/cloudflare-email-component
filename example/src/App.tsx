import {
  useSignInWithUsernamePassword,
  useSignUpWithUsernamePassword,
} from "@convex-dev/auth/methods/username-password/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { ConvexError } from "convex/values";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type View = "inbox" | "sent" | "archive" | "trash";
const views: [View, string][] = [
  ["inbox", "Inbox"],
  ["sent", "Sent"],
  ["archive", "Archive"],
  ["trash", "Trash"],
];

const when = (at: number) =>
  new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const isBad = (status?: string) =>
  ["failed", "bounced", "rejected", "complained"].includes(status ?? "");
const errorText = (e: unknown) =>
  e instanceof ConvexError
    ? String(e.data)
    : e instanceof Error
      ? e.message
      : String(e);

export function App() {
  return (
    <>
      <AuthLoading>
        <p className="empty">Loading…</p>
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
    <form className="sign-in" onSubmit={submit}>
      <h1>{flow === "signIn" ? "Sign in" : "Create your account"}</h1>
      <p className="note">Only the emails in INBOX_USERS can read mail.</p>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        minLength={8}
        autoComplete={flow === "signIn" ? "current-password" : "new-password"}
        required
      />
      <button className="primary" disabled={signingIn || signingUp}>
        {flow === "signIn" ? "Sign in" : "Sign up"}
      </button>
      {error && (
        <p className="bad" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="link"
        onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}
      >
        {flow === "signIn" ? "First time? Sign up" : "Have an account? Sign in"}
      </button>
    </form>
  );
}

function Inbox() {
  const { signOut } = useAuthActions();
  const me = useQuery(api.mail.me);
  if (me === undefined) return <p className="empty">Loading…</p>;
  if (me === null)
    return (
      <div className="sign-in">
        <h1>Not on the list</h1>
        <p className="note">
          Add your email to INBOX_USERS on the deployment, then reload.
        </p>
        <button className="link" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    );
  return <Mailbox me={me} />;
}

function Mailbox({ me }: { me: string }) {
  const { signOut } = useAuthActions();
  const unread = useQuery(api.mail.unreadCount) ?? 0;
  const inboxes = useQuery(api.mail.inboxes) ?? [];
  const [view, setView] = useState<View>("inbox");
  const [inbox, setInbox] = useState<string>();
  const [open, setOpen] = useState<Id<"threads"> | "compose">();
  const pick = (next: () => void) => {
    next();
    setOpen(undefined);
  };
  return (
    <div className="layout">
      <nav aria-label="Mailbox">
        <button className="primary compose" onClick={() => setOpen("compose")}>
          Compose
        </button>
        {views.map(([key, label]) => (
          <button
            key={key}
            className="row"
            aria-current={view === key}
            onClick={() => pick(() => setView(key))}
          >
            {label}
            {key === "inbox" && unread > 0 && (
              <span className="badge">{unread > 99 ? "99+" : unread}</span>
            )}
          </button>
        ))}
        <h2>Addresses</h2>
        {[undefined, ...inboxes].map((address) => (
          <button
            key={address ?? "all"}
            className="row"
            aria-current={inbox === address}
            onClick={() => pick(() => setInbox(address))}
          >
            {address ?? "All addresses"}
          </button>
        ))}
        <div className="me">
          <span className="note">{me}</span>
          <button className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </nav>
      <ThreadList view={view} inbox={inbox} open={open} setOpen={setOpen} />
      <main>
        {open === "compose" ? (
          <Compose
            inboxes={inboxes}
            from={inbox}
            done={(threadId) => setOpen(threadId ?? undefined)}
          />
        ) : open ? (
          <Thread key={open} threadId={open} close={() => setOpen(undefined)} />
        ) : (
          <p className="empty">Pick a conversation to read it.</p>
        )}
      </main>
    </div>
  );
}

function ThreadList({
  view,
  inbox,
  open,
  setOpen,
}: {
  view: View;
  inbox?: string;
  open?: string;
  setOpen: (id: Id<"threads">) => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.mail.threads,
    { view, inbox },
    { initialNumItems: 30 },
  );
  return (
    <section className="threads" aria-label="Conversations">
      {status === "LoadingFirstPage" ? (
        <p className="empty">Loading…</p>
      ) : results.length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        results.map((t) => (
          <button
            key={t._id}
            className={t.unread ? "row thread unread" : "row thread"}
            aria-current={open === t._id}
            onClick={() => setOpen(t._id)}
          >
            <span className="line">
              <span className="person">{t.with}</span>
              <span className="note">{when(t.lastAt)}</span>
            </span>
            <span className="subject">{t.subject || "(no subject)"}</span>
            <span className="preview">{t.snippet}</span>
          </button>
        ))
      )}
      {status === "CanLoadMore" && (
        <button className="link more" onClick={() => loadMore(30)}>
          Load more
        </button>
      )}
      {status === "LoadingMore" && <p className="empty">Loading…</p>}
    </section>
  );
}

function Thread({
  threadId,
  close,
}: {
  threadId: Id<"threads">;
  close: () => void;
}) {
  const thread = useQuery(api.mail.thread, { threadId });
  const setUnread = useMutation(api.mail.setUnread);
  const move = useMutation(api.mail.move);
  const unread = thread?.unread;
  useEffect(() => {
    if (unread) void setUnread({ threadId, unread: false });
  }, [unread, threadId, setUnread]);

  if (thread === undefined) return <p className="empty">Loading…</p>;
  if (thread === null)
    return <p className="empty">That conversation is gone.</p>;
  const latest = thread.messages.at(-1);
  const moveTo = (folder: "inbox" | "archive" | "trash") => {
    void move({ threadId, folder });
    close();
  };
  return (
    <>
      <div className="toolbar">
        {thread.folder !== "inbox" && (
          <button onClick={() => moveTo("inbox")}>Move to Inbox</button>
        )}
        {thread.folder !== "archive" && (
          <button onClick={() => moveTo("archive")}>Archive</button>
        )}
        {thread.folder !== "trash" && (
          <button onClick={() => moveTo("trash")}>Trash</button>
        )}
        <button
          onClick={() => {
            void setUnread({ threadId, unread: true });
            close();
          }}
        >
          Mark unread
        </button>
      </div>
      <div className="messages">
        <h2>{thread.subject || "(no subject)"}</h2>
        {thread.messages.map((m) => (
          <article key={m.id} className={m.direction}>
            <div className="meta">
              {m.direction === "inbound" && m.fromName
                ? `${m.fromName} <${m.from}>`
                : m.from}{" "}
              to {m.to.join(", ")} · {when(m.at)}
              {m.direction === "outbound" && (
                <>
                  {" · "}
                  <Status status={m.status} />
                </>
              )}
            </div>
            {m.direction === "outbound" && m.error && (
              <p className="bad">{m.error}</p>
            )}
            <div className="body">{m.text}</div>
            {m.attachments.length > 0 && (
              <ul className="attachments" aria-label="Attachments">
                {m.attachments.map((a) => (
                  <li key={a.storageId}>
                    {a.url ? (
                      <a href={a.url} download={a.filename}>
                        {a.filename}
                      </a>
                    ) : (
                      a.filename
                    )}{" "}
                    <span className="note">{Math.ceil(a.size / 1024)} KB</span>
                  </li>
                ))}
              </ul>
            )}
            {m.direction === "outbound" && m.messageId && (
              <Deliveries emailId={m.id} />
            )}
          </article>
        ))}
      </div>
      {latest && <Reply key={latest.id} to={latest} />}
    </>
  );
}

const Status = ({ status }: { status: string }) => (
  <span
    className={
      isBad(status)
        ? "status bad"
        : status === "delivered"
          ? "status good"
          : "status"
    }
  >
    {status}
  </span>
);

function Deliveries({ emailId }: { emailId: string }) {
  const events = useQuery(api.mail.deliveries, { emailId });
  if (!events) return null;
  if (events.length === 0)
    return <p className="note">No delivery events yet.</p>;
  return (
    <ul className="events" aria-label="Delivery history">
      {events.map((e) => (
        <li key={`${e.status}${e.at}${e.recipient}`}>
          <Status status={e.status} />{" "}
          {[e.recipient, when(e.at)].filter(Boolean).join(" · ")}
          {e.detail && <div className="note">{e.detail}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Uploads the files picked in a form's `files` input, ready to attach. */
function useUploads() {
  const uploadUrl = useMutation(api.mail.uploadUrl);
  return (form: FormData) =>
    Promise.all(
      (form.getAll("files") as File[])
        .filter((file) => file.size > 0)
        .map(async (file) => {
          const contentType = file.type || "application/octet-stream";
          const res = await fetch(await uploadUrl(), {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: file,
          });
          if (!res.ok) throw new Error(`${file.name} didn't upload.`);
          const { storageId } = (await res.json()) as {
            storageId: Id<"_storage">;
          };
          return { storageId, filename: file.name, contentType };
        }),
    );
}

const AttachInput = () => (
  <>
    <label htmlFor="files">Attachments</label>
    <input id="files" name="files" type="file" multiple />
  </>
);

function Reply({
  to,
}: {
  to: { id: string; inbox: string; replyTo: string[] };
}) {
  const reply = useAction(api.mail.reply);
  const uploads = useUploads();
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setResult("Sending…");
    try {
      const attachments = await uploads(new FormData(form));
      const { error } = await reply({ emailId: to.id, text, attachments });
      setResult(error ? `Not sent: ${error}` : "Sent.");
      if (!error) {
        setText("");
        form.reset();
      }
    } catch (e) {
      setResult(`Not sent: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="reply" onSubmit={submit}>
      <label htmlFor="reply">
        Reply from {to.inbox} to {to.replyTo.join(", ")}
      </label>
      <textarea
        id="reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
        required
      />
      <AttachInput />
      <div className="actions">
        <button className="primary" disabled={busy}>
          Send reply
        </button>
        <span className="note" role="status">
          {result}
        </span>
      </div>
    </form>
  );
}

function Compose({
  inboxes,
  from,
  done,
}: {
  inboxes: string[];
  from?: string;
  done: (threadId: Id<"threads"> | null) => void;
}) {
  const compose = useAction(api.mail.compose);
  const uploads = useUploads();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => `${form.get(name) as string}`.trim();
    setBusy(true);
    setError("");
    try {
      const { threadId, error } = await compose({
        from: field("from"),
        to: field("to")
          .split(/[,;\s]+/)
          .filter(Boolean),
        subject: field("subject"),
        text: field("text"),
        attachments: await uploads(form),
      });
      // A failed send is kept in Sent, so it can be read and retried there.
      if (error) setError(`Not sent: ${error}`);
      else done(threadId);
    } catch (e) {
      setError(`Not sent: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="compose-form" onSubmit={submit}>
      <h2>New message</h2>
      <label htmlFor="from">From</label>
      <input
        id="from"
        name="from"
        type="email"
        list="inboxes"
        defaultValue={from ?? inboxes[0]}
        required
      />
      <datalist id="inboxes">
        {inboxes.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <label htmlFor="to">To</label>
      <input
        id="to"
        name="to"
        placeholder="a@example.com, b@example.com"
        required
      />
      <label htmlFor="subject">Subject</label>
      <input id="subject" name="subject" required />
      <label htmlFor="text">Message</label>
      <textarea id="text" name="text" rows={12} required />
      <AttachInput />
      <div className="actions">
        <button className="primary" disabled={busy}>
          {busy ? "Sending…" : "Send"}
        </button>
        {error && (
          <span className="bad" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
