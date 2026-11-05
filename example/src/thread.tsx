import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import {
  Archive,
  Inbox,
  MailOpen,
  MoreVertical,
  Paperclip,
  Reply,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Folder = "inbox" | "archive" | "trash";

const when = (at: number) =>
  new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const initials = (name: string) =>
  name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("") || "?";
const errorText = (e: unknown) =>
  e instanceof ConvexError
    ? String(e.data)
    : e instanceof Error
      ? e.message
      : String(e);

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Thread({
  threadId,
  close,
}: {
  threadId?: Id<"threads">;
  close: () => void;
}) {
  const thread = useQuery(api.mail.thread, threadId ? { threadId } : "skip");
  const setUnread = useMutation(api.mail.setUnread);
  const move = useMutation(api.mail.move);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const unread = thread?.unread;
  useEffect(() => {
    if (threadId && unread) void setUnread({ threadId, unread: false });
  }, [unread, threadId, setUnread]);

  const moveTo = (folder: Folder) => {
    if (!threadId) return;
    void move({ threadId, folder });
    close();
  };
  const markUnread = () => {
    if (!threadId) return;
    void setUnread({ threadId, unread: true });
    close();
  };
  const has = !!thread;
  const latest = thread?.messages.at(-1);
  const name =
    latest?.direction === "inbound"
      ? latest.fromName || latest.from
      : (thread?.with ?? "");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[52px] items-center px-2">
        <div className="flex items-center gap-2">
          {thread?.folder === "inbox" || !has ? (
            <ToolButton
              label="Archive"
              disabled={!has}
              onClick={() => moveTo("archive")}
            >
              <Archive className="size-4" />
            </ToolButton>
          ) : (
            <ToolButton label="Move to Inbox" onClick={() => moveTo("inbox")}>
              <Inbox className="size-4" />
            </ToolButton>
          )}
          {thread?.folder !== "trash" && (
            <ToolButton
              label="Move to trash"
              disabled={!has}
              onClick={() => moveTo("trash")}
            >
              <Trash2 className="size-4" />
            </ToolButton>
          )}
          <Separator
            orientation="vertical"
            className="mx-1 data-[orientation=vertical]:h-6"
          />
          <ToolButton
            label="Mark as unread"
            disabled={!has}
            onClick={markUnread}
          >
            <MailOpen className="size-4" />
          </ToolButton>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ToolButton
            label="Reply"
            disabled={!has}
            onClick={() => replyBox.current?.focus()}
          >
            <Reply className="size-4" />
          </ToolButton>
        </div>
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-6"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={!has}
              aria-label="More"
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={markUnread}>
              Mark as unread
            </DropdownMenuItem>
            {(["inbox", "archive", "trash"] as const)
              .filter((folder) => folder !== thread?.folder)
              .map((folder) => (
                <DropdownMenuItem key={folder} onSelect={() => moveTo(folder)}>
                  Move to {folder[0]!.toUpperCase() + folder.slice(1)}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Separator />
      {!threadId ? (
        <p className="p-8 text-center text-muted-foreground">
          No message selected
        </p>
      ) : thread === undefined ? (
        <p className="p-8 text-center text-muted-foreground">Loading…</p>
      ) : thread === null ? (
        <p className="p-8 text-center text-muted-foreground">
          That conversation is gone.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-start p-4">
            <div className="flex min-w-0 items-start gap-4 text-sm">
              <Avatar>
                <AvatarFallback>{initials(name)}</AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 gap-1">
                <div className="truncate font-semibold">{name}</div>
                <div className="line-clamp-1 text-xs">
                  {thread.subject || "(no subject)"}
                </div>
                {latest && (
                  <div className="line-clamp-1 text-xs">
                    <span className="font-medium">Reply-To:</span>{" "}
                    {latest.replyTo.join(", ")}
                  </div>
                )}
              </div>
            </div>
            <div className="ml-auto shrink-0 pl-4 text-xs text-muted-foreground">
              {when(thread.lastAt)}
            </div>
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            {thread.messages.map((m, i) => (
              <article key={m.id} className="text-sm">
                {i > 0 && <Separator />}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-4 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {m.direction === "inbound" && m.fromName
                      ? `${m.fromName} <${m.from}>`
                      : m.from}
                  </span>
                  <span>to {m.to.join(", ")}</span>
                  <span className="ml-auto">{when(m.at)}</span>
                  {m.direction === "outbound" && <Status status={m.status} />}
                </div>
                {m.direction === "outbound" && m.error && (
                  <p className="px-4 pt-2 text-destructive">{m.error}</p>
                )}
                <div className="p-4 break-words whitespace-pre-wrap">
                  {m.text}
                </div>
                {m.attachments.length > 0 && (
                  <ul
                    aria-label="Attachments"
                    className="flex flex-wrap gap-2 px-4 pb-4"
                  >
                    {m.attachments.map((a) => (
                      <li key={a.storageId}>
                        <Badge variant="outline" asChild={!!a.url}>
                          {a.url ? (
                            <a href={a.url} download={a.filename}>
                              <Paperclip />
                              {a.filename} · {Math.ceil(a.size / 1024)} KB
                            </a>
                          ) : (
                            <span>{a.filename}</span>
                          )}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
                {m.direction === "outbound" && m.messageId && (
                  <Deliveries emailId={m.id} />
                )}
              </article>
            ))}
          </ScrollArea>
          <Separator />
          {latest && (
            <ReplyForm
              key={latest.id}
              to={latest}
              name={name}
              textarea={replyBox}
            />
          )}
        </div>
      )}
    </div>
  );
}

const isBad = (status: string) =>
  ["failed", "bounced", "rejected", "complained"].includes(status);

const Status = ({ status }: { status: string }) => (
  <Badge
    variant={
      isBad(status)
        ? "destructive"
        : status === "delivered"
          ? "default"
          : "secondary"
    }
  >
    {status}
  </Badge>
);

function Deliveries({ emailId }: { emailId: string }) {
  const events = useQuery(api.mail.deliveries, { emailId });
  if (!events) return null;
  return (
    <div className="mx-4 mb-4 rounded-md border border-dashed p-3 text-xs">
      {events.length === 0 ? (
        <p className="text-muted-foreground">No delivery events yet.</p>
      ) : (
        <ul aria-label="Delivery history" className="grid gap-2">
          {events.map((e) => (
            <li
              key={`${e.status}${e.at}${e.recipient}`}
              className="flex flex-wrap items-center gap-2"
            >
              <Status status={e.status} />
              <span className="text-muted-foreground">
                {[e.recipient, when(e.at)].filter(Boolean).join(" · ")}
              </span>
              {e.detail && (
                <span className="w-full text-muted-foreground">{e.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
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

const Attach = ({ id }: { id: string }) => (
  <div className="flex items-center gap-2">
    <Label htmlFor={id} className="text-muted-foreground">
      <Paperclip className="size-4" />
      <span className="sr-only">Attachments</span>
    </Label>
    <Input
      id={id}
      name="files"
      type="file"
      multiple
      className="h-8 max-w-64 text-xs"
    />
  </div>
);

function ReplyForm({
  to,
  name,
  textarea,
}: {
  to: { id: string; inbox: string; replyTo: string[] };
  name: string;
  textarea: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const reply = useAction(api.mail.reply);
  const uploads = useUploads();
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setResult("Sending…");
    try {
      const { error } = await reply({
        emailId: to.id,
        text: data.get("text") as string,
        attachments: await uploads(data),
      });
      setResult(error ? `Not sent: ${error}` : "Sent.");
      if (!error) form.reset();
    } catch (e) {
      setResult(`Not sent: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-4 p-4" onSubmit={submit}>
      <Textarea
        ref={textarea}
        name="text"
        className="p-4"
        aria-label={`Reply from ${to.inbox} to ${to.replyTo.join(", ")}`}
        placeholder={`Reply ${name}...`}
        required
      />
      <div className="flex flex-wrap items-center gap-2">
        <Attach id="reply-files" />
        <span role="status" className="text-xs text-muted-foreground">
          {result}
        </span>
        <Button size="sm" className="ml-auto" disabled={busy}>
          Send
        </Button>
      </div>
    </form>
  );
}

export function Compose({
  inboxes,
  from,
  close,
  done,
}: {
  inboxes: string[];
  from?: string;
  close: () => void;
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
    <div className="flex h-full flex-col">
      <div className="flex h-[52px] items-center px-4">
        <h2 className="font-semibold">New message</h2>
        <div className="ml-auto">
          <ToolButton label="Close" onClick={close}>
            <X className="size-4" />
          </ToolButton>
        </div>
      </div>
      <Separator />
      <form className="grid gap-4 p-4" onSubmit={submit}>
        <div className="grid gap-2">
          <Label htmlFor="from">From</Label>
          <Input
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
        </div>
        <div className="grid gap-2">
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            name="to"
            placeholder="a@example.com, b@example.com"
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="subject">Subject</Label>
          <Input id="subject" name="subject" required />
        </div>
        <Textarea
          name="text"
          aria-label="Message"
          className="min-h-48 p-4"
          required
        />
        <div className="flex flex-wrap items-center gap-2">
          <Attach id="compose-files" />
          {error && (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          )}
          <Button size="sm" className="ml-auto" disabled={busy}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function AddInbox({
  close,
  done,
}: {
  close: () => void;
  done: (address?: string) => void;
}) {
  const addInbox = useAction(api.mail.addInbox);
  const domains = useQuery(api.mail.domains) ?? [];
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const domain = address.split("@")[1]?.trim().toLowerCase() ?? "";
  // A zone is asked for once per domain, then remembered.
  const known = domains.find((d) => d.domain === domain);
  const needsZone = domain.includes(".") && !known;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await addInbox({
        address,
        zoneId: needsZone ? `${form.get("zoneId") as string}` : undefined,
        keepForwarding: form.get("keepForwarding") === "on",
      });
      const added = address.trim().toLowerCase();
      // A catch-all has no inbox of its own, so show them all.
      done(added.startsWith("*@") ? undefined : added);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[52px] items-center px-4">
        <h2 className="font-semibold">Add an inbox</h2>
        <div className="ml-auto">
          <ToolButton label="Close" onClick={close}>
            <X className="size-4" />
          </ToolButton>
        </div>
      </div>
      <Separator />
      <form className="grid max-w-lg gap-4 p-4" onSubmit={submit}>
        <p className="text-sm text-muted-foreground">
          Routes an address on your Cloudflare domain here. Its mail shows up
          under All inboxes with the rest, and on its own when you pick it.
        </p>
        <div className="grid gap-2">
          <Label htmlFor="address">Address</Label>
          <Input
            id="address"
            type="email"
            placeholder="hello@yourdomain.com"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Use *@yourdomain.com to catch every address that has no rule of its
            own. Each one shows up as its own inbox when mail arrives.
          </p>
        </div>
        {needsZone && (
          <div className="grid gap-2">
            <Label htmlFor="zoneId">Zone ID for {domain}</Label>
            <Input id="zoneId" name="zoneId" required />
            <p className="text-xs text-muted-foreground">
              On the domain&apos;s Overview page in Cloudflare, under API. Only
              needed the first time for this domain.
            </p>
          </div>
        )}
        <Label className="items-start gap-3 font-normal">
          <input
            type="checkbox"
            name="keepForwarding"
            className="mt-0.5 size-4 accent-primary"
          />
          <span className="grid gap-1">
            <span>Keep forwarding a copy</span>
            <span className="text-xs text-muted-foreground">
              If the address already forwards somewhere, like Gmail, bring it
              here and keep sending a copy there. One copy address per domain.
            </span>
          </span>
        </Label>
        {known?.forwardTo && (
          <p className="text-xs text-muted-foreground">
            Mail to {domain} is also copied to {known.forwardTo}.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Email Routing has to be on for the domain. Without the box ticked, an
          address that already has a routing rule is left alone.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {error && (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          )}
          <Button size="sm" className="ml-auto" disabled={busy}>
            {busy ? "Adding…" : "Add inbox"}
          </Button>
        </div>
      </form>
    </div>
  );
}
