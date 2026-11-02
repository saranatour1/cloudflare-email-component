import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { defineTestApp } from "convex-test";
import { defineSchema } from "convex/server";
import { v } from "convex/values";
import componentTest from "../test.js";
import { sendEmail, vEmail } from "./index.js";

const app = defineTestApp({
  schema: defineSchema({}),
  components: { cloudflareEmail: componentTest },
});
const { api, createTest } = app.defineModules({
  mail: {
    send: app.action({
      args: { email: vEmail },
      handler: (ctx, { email }) =>
        sendEmail(ctx, app.components.cloudflareEmail, {
          owner: "me",
          accountId: "account",
          apiToken: "secret-token",
          email,
          seal: (text) => `sealed:${text}`,
        }),
    }),
    get: app.query({
      args: { emailId: v.string() },
      handler: (ctx, { emailId }) =>
        ctx.runQuery(app.components.cloudflareEmail.lib.get, { emailId }),
    }),
  },
});

const email = {
  from: "me@example.com",
  to: ["you@example.com"],
  subject: "Hi",
  text: "Hello",
  attachments: [
    {
      content: "AAAA",
      filename: "a.txt",
      type: "text/plain",
      disposition: "attachment",
    },
  ],
};

describe("sendEmail", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("records a sent email, sealed and without its attachments", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: { message_id: "<a@b>", delivered: email.to },
        }),
      ),
    );
    const t = createTest();
    const { emailId, messageId, error } = await t.action(api.mail.send, {
      email,
    });
    expect(messageId).toBe("<a@b>");
    expect(error).toBeUndefined();

    const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(sent.attachments).toHaveLength(1);
    const stored = await t.query(api.mail.get, { emailId });
    expect(stored?.status).toBe("sent");
    expect(stored?.payload.startsWith("sealed:")).toBe(true);
    expect(JSON.parse(stored!.payload.slice("sealed:".length))).toEqual({
      ...email,
      attachments: [],
    });
    expect(JSON.stringify(stored)).not.toContain("secret-token");
  });

  test("records a refused email with its error sealed", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, errors: [{ message: "no" }] }),
        {
          status: 400,
        },
      ),
    );
    const t = createTest();
    const { emailId, error } = await t.action(api.mail.send, { email });
    expect(error).toBe("no");
    const stored = await t.query(api.mail.get, { emailId });
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toBe("sealed:no");
  });
});
