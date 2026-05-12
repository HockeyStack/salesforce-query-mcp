import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { runClaudeLoop, Message } from "./claude.js";

const SLACK_PORT = parseInt(process.env.SLACK_PORT ?? "3000", 10);

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

async function handleMessage(
  text: string,
  channelId: string,
  threadTs: string,
  say: Function
) {
  // Post a placeholder so users know the bot is working
  const thinkingMsg = await say({
    text: "_Thinking..._",
    thread_ts: threadTs,
  });

  try {
    const history = getHistory(threadTs);
    const reply = await runClaudeLoop(text, history);

    appendHistory(threadTs, "user", text);
    appendHistory(threadTs, "assistant", reply);

    await app.client.chat.update({
      channel: channelId,
      ts: thinkingMsg.ts as string,
      text: reply,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("handleMessage error:", errMsg);
    await app.client.chat.update({
      channel: channelId,
      ts: thinkingMsg.ts as string,
      text: `:warning: Something went wrong: ${errMsg}`,
    });
  }
}

// Channel mentions: @SalesforceMCP what is ...
app.event("app_mention", async ({ event, say }) => {
  // Strip the @mention tag from the message text
  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;
  const threadTs = event.thread_ts ?? event.ts;
  await handleMessage(text, event.channel, threadTs, say);
});

// Direct messages: no @mention needed
app.message(async ({ message, say }) => {
  const msg = message as any;
  // Ignore subtypes (edits, deletes, bot messages, etc.)
  if (msg.subtype || msg.bot_id || !msg.text) return;
  const threadTs = msg.thread_ts ?? msg.ts;
  await handleMessage(msg.text, msg.channel, threadTs, say);
});

app.error(async (error) => {
  console.error("Bolt error:", error);
});

(async () => {
  await app.start();
  console.log(`Salesforce MCP Slack bot running on port ${SLACK_PORT}`);
})();
