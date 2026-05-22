import "dotenv/config";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import type { SayFn } from "@slack/bolt";
import { runClaudeLoop, Message, WriteInvocation } from "./claude.js";

const SLACK_PORT = parseInt(process.env.SLACK_PORT ?? "3000", 10);
const AUDIT_CHANNEL_ID = process.env.SLACK_AUDIT_CHANNEL_ID;

// Use an explicit receiver so we can attach extra routes (e.g. /health)
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

receiver.app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "slack-bot" });
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.WARN,
});

// In-memory thread history: threadTs → last N messages
// Lets teammates have a back-and-forth conversation in a thread without re-explaining context
const threadHistory = new Map<string, Message[]>();
const MAX_HISTORY_MESSAGES = 20;

function getHistory(threadTs: string): Message[] {
  return threadHistory.get(threadTs) ?? [];
}

function appendHistory(threadTs: string, role: "user" | "assistant", content: string) {
  const history = getHistory(threadTs);
  history.push({ role, content });
  // Trim oldest messages when history grows too long
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
  threadHistory.set(threadTs, history);
}

async function postAuditMessage(
  userId: string,
  threadLink: string | null,
  write: WriteInvocation
) {
  if (!AUDIT_CHANNEL_ID) return;
  const inputJson = JSON.stringify(write.input);
  const truncatedInput =
    inputJson.length > 1500 ? inputJson.slice(0, 1500) + "...(truncated)" : inputJson;
  const url = write.output?.url ?? "(no url returned)";
  const lines = [
    `*${write.tool}* by <@${userId}>`,
    `Result: ${url}`,
    "Input:",
    "```",
    truncatedInput,
    "```",
  ];
  if (threadLink) lines.push(`Source thread: ${threadLink}`);
  try {
    await app.client.chat.postMessage({
      channel: AUDIT_CHANNEL_ID,
      text: lines.join("\n"),
    });
  } catch (err) {
    console.error("Failed to post audit message:", err);
  }
}

async function handleMessage(
  text: string,
  threadTs: string,
  userId: string,
  channelId: string,
  say: SayFn
) {
  await say({ text: "_Thinking..._", thread_ts: threadTs });

  try {
    const history = getHistory(threadTs);
    const { reply, writes } = await runClaudeLoop(text, history, userId);

    appendHistory(threadTs, "user", text);
    appendHistory(threadTs, "assistant", reply);

    await say({ text: reply, thread_ts: threadTs });

    // Audit every successful write tool invocation
    if (writes.length > 0) {
      const threadLink = `https://slack.com/archives/${channelId}/p${threadTs.replace(".", "")}`;
      for (const w of writes) {
        await postAuditMessage(userId, threadLink, w);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("handleMessage error:", errMsg);
    await say({ text: `Something went wrong: ${errMsg}`, thread_ts: threadTs });
  }
}

// Channel mentions: @RevopsMCP what is ...
app.event("app_mention", async ({ event, say }) => {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;
  if (!event.user) return;
  const threadTs = event.thread_ts ?? event.ts;
  // Don't await - return immediately so Bolt acks the event before Slack's 3s retry window
  handleMessage(text, threadTs, event.user, event.channel, say).catch(console.error);
});

// Direct messages only - channel mentions are handled by app_mention above.
// Without this guard, @mentions in channels fire both handlers and the bot responds twice.
app.message(async ({ message, say }) => {
  const msg = message as any;
  if (msg.subtype || msg.bot_id || !msg.text || !msg.user) return;
  if (msg.channel_type !== "im") return;
  const threadTs = msg.thread_ts ?? msg.ts;
  handleMessage(msg.text, threadTs, msg.user, msg.channel, say).catch(console.error);
});

app.error(async (error) => {
  console.error("Bolt error:", error);
});

(async () => {
  await app.start(SLACK_PORT);
  console.log(`Salesforce MCP Slack bot running on port ${SLACK_PORT}`);
})();
