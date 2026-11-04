// The browser code is plain text here, so `pnpm run typecheck` doesn't see it. Mail only
// ever reaches the page through `textContent`, never as HTML.
export const inboxPage = (nonce: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inbox</title>
<style nonce="${nonce}">
:root {
  color-scheme: light dark;
  --bg: light-dark(#fbfaf7, #1b1b1a);
  --raised: light-dark(#ffffff, #252523);
  --ink: light-dark(#23231f, #ecebe6);
  --muted: light-dark(#6a6a62, #a5a59d);
  --line: light-dark(#dfddd5, #3a3a36);
  --accent: light-dark(#9a3b0c, #f3a875);
  --selected: light-dark(#f3e9df, #3a2d24);
  --bad: light-dark(#a3161b, #ff8f8f);
}
* { box-sizing: border-box; }
body {
  margin: 0; height: 100dvh; display: grid; background: var(--bg); color: var(--ink);
  grid-template-columns: 220px 320px minmax(0, 1fr);
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
nav, #threads { overflow-y: auto; border-right: 1px solid var(--line); }
nav { padding: 16px 8px; }
h1 { font-size: 15px; margin: 0 8px 12px; }
button { font: inherit; color: inherit; cursor: pointer; }
.row {
  display: block; width: 100%; text-align: left; background: none;
  border: 0; border-radius: 6px; padding: 8px; overflow-wrap: anywhere;
}
.row:hover { background: var(--selected); }
.row[aria-current="true"] { background: var(--selected); font-weight: 600; }
#threads .row { border-radius: 0; border-bottom: 1px solid var(--line); padding: 12px 16px; }
#threads .row[aria-current="true"] { font-weight: 400; }
.person, .subject, .preview { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subject { font-weight: 600; }
.preview, .meta, .note { color: var(--muted); font-size: 13px; }
main { display: flex; flex-direction: column; min-height: 0; }
#messages { flex: 1; overflow-y: auto; padding: 24px; }
h2 { font-size: 20px; line-height: 1.25; margin: 0 0 16px; overflow-wrap: anywhere; }
article { background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
article.outbound { border-left: 3px solid var(--accent); }
.meta { overflow-wrap: anywhere; margin-bottom: 8px; }
.status { color: var(--accent); font-weight: 600; }
.status.bad, .bad { color: var(--bad); }
.body { white-space: pre-wrap; overflow-wrap: anywhere; }
form { border-top: 1px solid var(--line); padding: 12px 24px 16px; }
form[hidden] { display: none; }
label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; overflow-wrap: anywhere; }
textarea {
  display: block; width: 100%; min-height: 84px; resize: vertical; font: inherit; color: inherit;
  background: var(--raised); border: 1px solid var(--line); border-radius: 6px; padding: 8px;
}
.actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
#send { background: var(--accent); color: var(--bg); border: 0; border-radius: 6px; padding: 7px 16px; font-weight: 600; white-space: nowrap; }
#send:disabled { opacity: .6; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.empty { color: var(--muted); padding: 16px; }
.events { list-style: none; margin: 12px 0 0; padding: 10px 0 0; border-top: 1px dashed var(--line); font-size: 13px; }
.events li { margin-bottom: 6px; overflow-wrap: anywhere; }
@media (max-width: 800px) {
  body { display: flex; flex-direction: column; height: auto; min-height: 100dvh; }
  nav, #threads { border-right: 0; border-bottom: 1px solid var(--line); }
  #threads { max-height: 40dvh; }
  #messages, form { padding-left: 16px; padding-right: 16px; }
}
</style>
</head>
<body>
<nav aria-label="Inboxes"><h1>Inboxes</h1><div id="inboxes"></div></nav>
<section id="threads" aria-label="Conversations"></section>
<main>
  <div id="messages"></div>
  <form id="reply" hidden>
    <label for="text" id="label"></label>
    <textarea id="text" required></textarea>
    <div class="actions">
      <button id="send">Send reply</button>
      <span id="result" class="note" role="status"></span>
    </div>
  </form>
</main>
<script nonce="${nonce}">
const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const when = (at) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const idOf = (thread) => thread[0].id;
const person = (m) => m.direction === "inbound" ? m.fromName || m.from : m.to.join(", ");
const isBad = (status) => ["failed", "bounced", "rejected", "complained"].includes(status);
const statusTag = (status) => el("span", isBad(status) ? "status bad" : "status", status);
const rowButton = (selected, pick) => {
  const button = el("button", "row");
  button.type = "button";
  button.setAttribute("aria-current", String(selected));
  button.onclick = pick;
  return button;
};

let threads = [];
let inbox = null;
let open = null;
let last = "";
let loaded = false;

function render() {
  if (!loaded) {
    $("threads").replaceChildren(el("p", "empty", "Loading…"));
    $("messages").replaceChildren();
    return;
  }
  const addresses = [...new Set(threads.flatMap((t) => t.map((m) => m.inbox)))].sort();
  const shown = threads.filter((t) => !inbox || t.some((m) => m.inbox === inbox));
  if (!shown.some((t) => idOf(t) === open)) open = shown[0] ? idOf(shown[0]) : null;
  const count = (address) => threads.filter((t) => t.some((m) => m.inbox === address)).length;
  $("inboxes").replaceChildren(
    ...[null, ...addresses].map((address) => {
      const button = rowButton(address === inbox, () => { inbox = address; open = null; render(); });
      button.textContent = address ?? "All inboxes";
      button.append(el("span", "note", " " + (address ? count(address) : threads.length)));
      return button;
    }),
  );
  $("threads").replaceChildren(
    ...(shown.length ? shown.map((thread) => {
      const latest = thread.at(-1);
      const button = rowButton(idOf(thread) === open, () => { open = idOf(thread); $("result").textContent = ""; $("text").value = ""; render(); });
      button.append(
        el("span", "person", person(latest)),
        el("span", "subject", thread[0].subject || "(no subject)"),
        el("span", "preview", when(latest.at) + " · " + latest.text),
      );
      return button;
    }) : [el("p", "empty", "No mail here yet.")]),
  );
  const thread = shown.find((t) => idOf(t) === open);
  $("reply").hidden = !thread;
  if (!thread) {
    $("messages").replaceChildren(el("p", "empty", "Pick a conversation to read it."));
    return;
  }
  $("messages").replaceChildren(
    el("h2", "", thread[0].subject || "(no subject)"),
    ...thread.map((m) => {
      const article = el("article", m.direction);
      const meta = el("div", "meta", m.from + " to " + m.to.join(", ") + " · " + when(m.at));
      if (m.status) meta.append(" · ", statusTag(m.status));
      article.append(meta);
      if (m.error) article.append(el("p", "bad", m.error));
      article.append(el("div", "body", m.text));
      if (m.attachments?.length) article.append(el("p", "note", "Attachments not kept: " + m.attachments.join(", ")));
      if (m.events?.length) {
        const list = el("ul", "events");
        list.setAttribute("aria-label", "Delivery history");
        for (const e of m.events) {
          const item = el("li");
          item.append(statusTag(e.status), " " + [e.recipient, when(e.at)].filter(Boolean).join(" · "));
          if (e.detail) item.append(el("div", "note", e.detail));
          list.append(item);
        }
        article.append(list);
      } else if (m.direction === "outbound" && m.messageId) {
        article.append(el("p", "note", "No delivery events yet."));
      }
      return article;
    }),
  );
  const latest = thread.at(-1);
  $("label").textContent = "Reply from " + latest.inbox + " to " + latest.replyTo.join(", ");
}

async function load() {
  try {
    const res = await fetch("/inbox/threads");
    if (!res.ok) throw new Error(res.status);
    const body = await res.text();
    if (body === last) return;
    last = body;
    threads = JSON.parse(body);
    loaded = true;
    render();
  } catch (e) {
    if (!loaded) $("threads").replaceChildren(el("p", "empty bad", "Couldn't load mail: " + e.message));
    else $("result").textContent = "Couldn't refresh: " + e.message;
  }
}

$("reply").onsubmit = async (event) => {
  event.preventDefault();
  const thread = threads.find((t) => idOf(t) === open);
  $("send").disabled = true;
  $("result").textContent = "Sending…";
  try {
    const res = await fetch("/inbox/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emailId: thread.at(-1).id, text: $("text").value }),
    });
    const sent = res.ok ? await res.json() : { error: "HTTP " + res.status };
    $("result").textContent = sent.error ? "Not sent: " + sent.error : "Sent.";
    if (!sent.error) $("text").value = "";
    await load();
  } catch (e) {
    $("result").textContent = "Not sent: " + e.message;
  } finally {
    $("send").disabled = false;
  }
};

render();
load();
setInterval(load, 5000);
</script>
</body>
</html>
`;
