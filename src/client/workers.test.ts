// @vitest-environment node
// Runs the Workers' source as Cloudflare would call it. Node, as edge-runtime refuses `new Function`.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { eventsWorker, inboundWorker } from "./cloudflare.js";

const load = (source: string) =>
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function(`return ${source.replace("export default", "").trim()}`)() as {
    queue: (batch: unknown, env: unknown) => Promise<void>;
    email: (message: unknown, env: unknown) => Promise<void>;
  };

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("eventsWorker", () => {
  const env = { EVENTS_URL: "https://app/events", SECRET: "s" };
  const batch = { messages: [{ body: { a: 1 } }, { body: { a: 2 } }] };

  test("posts the batch's bodies with the secret", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await load(eventsWorker).queue(batch, env);
    const [url, init] = fetchMock.mock.lastCall!;
    expect(url).toBe(env.EVENTS_URL);
    expect(init!.headers).toMatchObject({ Authorization: "Bearer s" });
    expect(JSON.parse(init!.body as string)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test.each([401, 500])("throws on a %i, so Queues retries", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    await expect(load(eventsWorker).queue(batch, env)).rejects.toThrow(
      String(status),
    );
  });
});

describe("inboundWorker", () => {
  const message = () => ({
    from: "them@example.com",
    to: "me@example.com",
    raw: new TextEncoder().encode("Subject: Hi\r\n\r\nHello"),
    setReject: vi.fn(),
    forward: vi.fn(() => Promise.resolve()),
  });
  const env = { INBOUND_URL: "https://app/in", SECRET: "s" };
  const answers = (status: number) =>
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));

  test("posts the raw message and envelope", async () => {
    answers(204);
    const m = message();
    await load(inboundWorker).email(m, env);
    const [, init] = fetchMock.mock.lastCall!;
    expect(init!.headers).toMatchObject({
      Authorization: "Bearer s",
      "X-Envelope-From": "them@example.com",
      "X-Envelope-To": "me@example.com",
    });
    expect(new TextDecoder().decode(init!.body as ArrayBuffer)).toContain(
      "Subject: Hi",
    );
    expect(m.setReject).not.toHaveBeenCalled();
    expect(m.forward).not.toHaveBeenCalled();
  });

  test("a 403 turns the message away", async () => {
    answers(403);
    const m = message();
    await load(inboundWorker).email(m, env);
    expect(m.setReject).toHaveBeenCalled();
  });

  test("a 403 still forwards if there's somewhere to forward it", async () => {
    answers(403);
    const m = message();
    await load(inboundWorker).email(m, { ...env, FORWARD_TO: "me@else.com" });
    expect(m.setReject).not.toHaveBeenCalled();
    expect(m.forward).toHaveBeenCalledWith("me@else.com");
  });

  test("anything else throws, so Cloudflare tries again", async () => {
    answers(500);
    const m = message();
    await expect(load(inboundWorker).email(m, env)).rejects.toThrow("500");
    expect(m.forward).not.toHaveBeenCalled();
  });

  test("a failed forward doesn't lose a message the app already took", async () => {
    answers(204);
    const m = message();
    m.forward.mockRejectedValueOnce(new Error("not verified"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await load(inboundWorker).email(m, { ...env, FORWARD_TO: "me@else.com" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
