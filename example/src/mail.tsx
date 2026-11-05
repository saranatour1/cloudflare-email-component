import { useAuthActions } from "@convex-dev/auth/react";
import { cn } from "cn";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
  Archive,
  AtSign,
  Inbox,
  LogOut,
  type LucideIcon,
  Search,
  Send,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { type ReactNode, useDeferredValue, useState } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AddInbox, Compose, Thread } from "./thread";

export type View = "inbox" | "sent" | "archive" | "trash";

const views: { view: View; title: string; icon: LucideIcon }[] = [
  { view: "inbox", title: "Inbox", icon: Inbox },
  { view: "sent", title: "Sent", icon: Send },
  { view: "archive", title: "Archive", icon: Archive },
  { view: "trash", title: "Trash", icon: Trash2 },
];

const allAddresses = "all";

export function Mail({ me }: { me: string }) {
  const { signOut } = useAuthActions();
  const inboxes = useQuery(api.mail.inboxes) ?? [];
  const unread = useQuery(api.mail.unreadCount) ?? 0;
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<View>("inbox");
  const [inbox, setInbox] = useState<string>();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Id<"threads"> | "compose" | "add-inbox">();
  const title = views.find((v) => v.view === view)!.title;

  return (
    <TooltipProvider delayDuration={0}>
      {/* A style, as the library's inline height: 100% would beat a class. */}
      <ResizablePanelGroup
        orientation="horizontal"
        style={{ height: "100dvh" }}
      >
        <ResizablePanel
          defaultSize="18"
          minSize="14"
          maxSize="22"
          collapsible
          collapsedSize={52}
          onResize={(size) => setCollapsed(size.inPixels < 120)}
          className={cn("flex flex-col", collapsed && "min-w-[52px]")}
        >
          <div
            className={cn(
              "flex h-[52px] items-center justify-center",
              !collapsed && "px-2",
            )}
          >
            <Select
              value={inbox ?? allAddresses}
              onValueChange={(value) => {
                setInbox(value === allAddresses ? undefined : value);
                setOpen(undefined);
              }}
            >
              <SelectTrigger
                aria-label="Inbox"
                className={cn(
                  "w-full [&>span]:flex-1 [&>span]:truncate [&>span]:text-left",
                  collapsed &&
                    "size-9 justify-center p-0 [&>span]:hidden [&>svg]:hidden",
                )}
              >
                <AtSign className="size-4 shrink-0" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={allAddresses}>All inboxes</SelectItem>
                {inboxes.map((address) => (
                  <SelectItem key={address} value={address}>
                    {address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className={cn("p-2", collapsed && "flex justify-center")}>
            <NavButton
              collapsed={collapsed}
              title="New message"
              icon={SquarePen}
              variant="outline"
              onClick={() => setOpen("compose")}
            />
          </div>
          <nav
            aria-label="Folders"
            className={cn("grid gap-1 px-2", collapsed && "justify-center")}
          >
            {views.map(({ view: key, title, icon }) => (
              <NavButton
                key={key}
                collapsed={collapsed}
                title={title}
                icon={icon}
                current={view === key}
                label={key === "inbox" && unread > 0 ? unread : undefined}
                onClick={() => {
                  setView(key);
                  setOpen(undefined);
                }}
              />
            ))}
          </nav>
          <div
            className={cn(
              "mt-auto grid gap-1 p-2",
              collapsed && "justify-center",
            )}
          >
            <NavButton
              collapsed={collapsed}
              title="Add inbox"
              icon={Plus}
              current={open === "add-inbox"}
              onClick={() => setOpen("add-inbox")}
            />
            <Separator className="my-1" />
            {!collapsed && (
              <p className="truncate px-3 text-xs text-muted-foreground">
                {me}
              </p>
            )}
            <NavButton
              collapsed={collapsed}
              title="Sign out"
              icon={LogOut}
              onClick={() => void signOut()}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="32" minSize="24" className="flex flex-col">
          <Tabs
            value={unreadOnly ? "unread" : "all"}
            onValueChange={(value) => setUnreadOnly(value === "unread")}
          >
            <div className="flex h-[52px] items-center px-4">
              <h1 className="text-xl font-bold">{title}</h1>
              <TabsList className="ml-auto">
                <TabsTrigger value="all">All mail</TabsTrigger>
                <TabsTrigger value="unread">Unread</TabsTrigger>
              </TabsList>
            </div>
          </Tabs>
          <Separator />
          <form
            className="p-4"
            role="search"
            onSubmit={(e) => e.preventDefault()}
          >
            <div className="relative">
              <Search className="absolute top-2.5 left-2 size-4 text-muted-foreground" />
              <Input
                aria-label="Search"
                placeholder="Search"
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </form>
          <MailList
            view={view}
            inbox={inbox}
            unreadOnly={unreadOnly}
            search={search}
            open={open}
            setOpen={setOpen}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="50" minSize="30">
          {open === "add-inbox" ? (
            <AddInbox
              close={() => setOpen(undefined)}
              done={(address) => {
                setInbox(address);
                setOpen(undefined);
              }}
            />
          ) : open === "compose" ? (
            <Compose
              inboxes={inboxes}
              from={inbox}
              close={() => setOpen(undefined)}
              done={(threadId) => setOpen(threadId ?? undefined)}
            />
          ) : (
            <Thread
              key={open}
              threadId={open}
              close={() => setOpen(undefined)}
            />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </TooltipProvider>
  );
}

function NavButton({
  collapsed,
  title,
  icon: Icon,
  label,
  current = false,
  variant,
  onClick,
}: {
  collapsed: boolean;
  title: string;
  icon: LucideIcon;
  label?: ReactNode;
  current?: boolean;
  variant?: "outline";
  onClick: () => void;
}) {
  const look = variant ?? (current ? "default" : "ghost");
  // As in shadcn's example: the selected folder is muted rather than white in dark mode.
  const selected =
    current &&
    "dark:bg-muted dark:text-white dark:hover:bg-muted dark:hover:text-white";
  if (collapsed)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-current={current || undefined}
            aria-label={title}
            onClick={onClick}
            className={cn(
              buttonVariants({ variant: look, size: "icon" }),
              selected,
            )}
          >
            <Icon className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-4">
          {title}
          {label !== undefined && <span className="ml-auto">{label}</span>}
        </TooltipContent>
      </Tooltip>
    );
  return (
    <Button
      variant={look}
      size="sm"
      aria-current={current || undefined}
      onClick={onClick}
      className={cn("w-full justify-start", selected)}
    >
      <Icon className="mr-2 size-4" />
      {title}
      {label !== undefined && <span className="ml-auto">{label}</span>}
    </Button>
  );
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];
const ago = (at: number) => {
  const seconds = (at - Date.now()) / 1000;
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? [
    "second",
    1,
  ];
  return unit === "second"
    ? "just now"
    : relative.format(Math.round(seconds / size), unit);
};

function MailList({
  view,
  inbox,
  unreadOnly,
  search,
  open,
  setOpen,
}: {
  view: View;
  inbox?: string;
  unreadOnly: boolean;
  search: string;
  open?: string;
  setOpen: (id: Id<"threads">) => void;
}) {
  // Waits for typing to settle before searching.
  const query = useDeferredValue(search.trim());
  const { results, status, loadMore } = usePaginatedQuery(
    api.mail.threads,
    { view, inbox, unreadOnly, search: query || undefined },
    { initialNumItems: 30 },
  );
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2 p-4 pt-0">
        {status === "LoadingFirstPage" ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : results.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {query ? "Nothing matches." : "Nothing here."}
          </p>
        ) : (
          results.map((t) => (
            <button
              key={t._id}
              type="button"
              aria-current={open === t._id || undefined}
              onClick={() => setOpen(t._id)}
              className={cn(
                "flex flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm transition-all hover:bg-accent",
                open === t._id && "bg-muted",
              )}
            >
              <div className="flex w-full flex-col gap-1">
                <div className="flex items-center gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn("truncate", t.unread && "font-semibold")}
                    >
                      {t.with}
                    </span>
                    {t.unread && (
                      <span
                        aria-label="Unread"
                        className="flex size-2 shrink-0 rounded-full bg-blue-600"
                      />
                    )}
                  </div>
                  <span
                    className={cn(
                      "ml-auto shrink-0 text-xs",
                      open === t._id
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {ago(t.lastAt)}
                  </span>
                </div>
                <div className="text-xs font-medium">
                  {t.subject || "(no subject)"}
                </div>
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">
                {t.snippet}
              </div>
              {(!inbox || (view === "sent" && t.folder !== "archive")) && (
                <div className="flex flex-wrap items-center gap-2">
                  {!inbox && <Badge variant="secondary">{t.inbox}</Badge>}
                  {view === "sent" && t.folder !== "archive" && (
                    <Badge variant="outline">{t.folder}</Badge>
                  )}
                </div>
              )}
            </button>
          ))
        )}
        {status === "CanLoadMore" && (
          <Button variant="ghost" size="sm" onClick={() => loadMore(30)}>
            Load more
          </Button>
        )}
        {status === "LoadingMore" && (
          <p className="p-2 text-center text-sm text-muted-foreground">
            Loading…
          </p>
        )}
      </div>
    </ScrollArea>
  );
}
