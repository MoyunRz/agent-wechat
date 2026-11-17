import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeReplyGates, NATIVE_REPLY_CIRCUIT_MS, NATIVE_REPLY_DEBOUNCE_MS, NATIVE_REPLY_INTERVAL_MS } from "./native-reply-gates.ts";
import { NativeConsumerState } from "./native-consumer-state.ts";
import { dispatchNativeMessage } from "./native-monitor.ts";
import { resolveWeChatAccount } from "./types.ts";
import type { NativeMessage, NativeWeChatClient } from "@agent-wechat/shared";
// The monitor fixtures depend on POSIX directory permission checks that
// Windows cannot satisfy; the dispatch-level coverage runs on Linux CI.
const monitorTest = (name: string, fn: (t: any) => Promise<void> | void) =>
  test(name, { skip: platform() === "win32" ? "POSIX-only consumer state permissions" : false }, fn);
test("a fresh burst defers until the thread stays quiet", () => {
  const gates = new NativeReplyGates();
  const now = 1_000_000_000_000;
  gates.markSeen("m1", now);
  assert.equal(gates.deferReply("u", gates.seenAtOf("m1"), now), true);
  assert.equal(gates.deferReply("u", gates.seenAtOf("m1"), now + NATIVE_REPLY_DEBOUNCE_MS), false);
});
test("the newest message of a burst decides the quiet window", () => {
  const gates = new NativeReplyGates();
  const now = 1_000_000_000_000;
  gates.markSeen("m1", now - 60_000);
  gates.markSeen("m2", now - 2_000);
  const newest = Math.max(gates.seenAtOf("m1"), gates.seenAtOf("m2"));
  assert.equal(gates.deferReply("u", newest, now), true);
  assert.equal(gates.deferReply("u", gates.seenAtOf("m1"), now), false);
});
test("replies to one thread keep a spacing window without touching other threads", () => {
  const gates = new NativeReplyGates();
  const now = 1_000_000_000_000;
  gates.markSeen("m1", now - 60_000);
  gates.recordReply("u", now - 5_000);
  assert.equal(gates.deferReply("u", gates.seenAtOf("m1"), now), true);
  assert.equal(gates.deferReply("u", gates.seenAtOf("m1"), now + NATIVE_REPLY_INTERVAL_MS), false);
  assert.equal(gates.deferReply("v", now - 60_000, now), false);
});
test("an uncertain outcome pauses every reply for an hour", () => {
  const gates = new NativeReplyGates();
  const now = 1_000_000_000_000;
  gates.markSeen("m1", now - 60_000);
  gates.tripCircuit(now);
  assert.equal(gates.deferReply("u", gates.seenAtOf("m1"), now), true);
  assert.equal(gates.deferReply("v", now - 60_000, now), true);
  assert.equal(gates.deferReply("u", gates.seenAtOf("m1"), now + NATIVE_REPLY_CIRCUIT_MS), false);
});
function monitorFixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "native-reply-gates-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cfg: any = { channels: { "agent-wechat": { backend: "native", dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open", groupAllowFrom: ["*"],
    native: { mode: "external", endpoint: "http://127.0.0.1:6174", accountId: "a", token: "synthetic-native-token-".repeat(3), consumerStateDir: directory, readPolicy: "on_inbound" } } } };
  const account = resolveWeChatAccount(cfg)!;
  const state = new NativeConsumerState(directory, "s", "a");
  const message: NativeMessage = { id: "m1", accountId: "a", threadId: "u", senderId: "u", serverId: "9007199254740999", type: 1, direction: "incoming", body: "latest hello", createdAt: "2026-10-20T12:00:00Z", version: "1", media: [], mentions: { state: "unknown", userIds: [], self: null, all: null, source: null } };
  const runs: any[] = [];
  const core: any = { channel: {
    commands: { shouldHandleTextCommands: () => false, isControlCommandMessage: () => false, shouldComputeCommandAuthorized: () => false },
    pairing: { readAllowFromStore: async () => [] },
    inbound: { ingress: { resolveStable: async () => ({ ingress: { admission: "dispatch", reasonCode: "fixture" }, activationAccess: {}, commandAccess: {} }) } },
    routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "test", accountId: "default" }) },
    session: { resolveStorePath: () => "/unused", recordInboundSession: async () => {} },
    reply: { resolveEnvelopeFormatOptions: () => ({}), formatAgentEnvelope: ({ body }: any) => body, finalizeInboundContext: (ctx: any) => ctx,
      dispatchReplyWithBufferedBlockDispatcher: async (params: any) => { runs.push(params); params.replyOptions.onPreparedAgentRunStart?.("run_1"); } },
  } };
  const client = { sendText: async () => ({ id: "send_1", state: "accepted" }),
    message: async (_account: string, messageId: string) => state.get(messageId)!.message } as unknown as NativeWeChatClient;
  return { cfg, account, state, message, core, client, runs, createPipeline: (() => ({ onModelSelected: () => {} })) as any };
}
monitorTest("a fresh burst defers dispatch and keeps custody", async t => {
  const value = monitorFixture(t);
  value.state.accept("1", value.message, "live");
  const gates = new NativeReplyGates();
  gates.markSeen(value.message.id);
  assert.equal(await dispatchNativeMessage({
    ...value, gates,
    prepareAttachment: async () => ({ body: value.message.body ?? "", pending: false }),
  }), "pending");
  assert.equal(value.runs.length, 0);
  assert.equal(value.state.get("m1")?.state, "received");
});
monitorTest("a quiet burst aggregates into one turn and consumes the earlier messages", async t => {
  const value = monitorFixture(t);
  const older: NativeMessage = { ...value.message, id: "m0", body: "first hello" };
  value.state.accept("1", older, "live");
  value.state.accept("2", value.message, "live");
  const gates = new NativeReplyGates();
  const quiet = Date.now() - 60_000;
  gates.markSeen("m0", quiet);
  gates.markSeen("m1", quiet);
  assert.equal(await dispatchNativeMessage({
    ...value, gates,
    prepareAttachment: async ({ message }: { message: NativeMessage }) => ({ body: message.body ?? "", pending: false }),
  }), "completed");
  assert.equal(value.runs.length, 1);
  assert.ok(JSON.stringify(value.runs[0].ctx.InboundHistory ?? []).includes("first hello"));
  assert.equal(value.state.get("m0")?.state, "ignored");
  assert.equal(value.state.get("m1")?.state, "completed");
});
monitorTest("the reply spacing gate defers a quiet thread that was just answered", async t => {
  const value = monitorFixture(t);
  value.state.accept("1", value.message, "live");
  const gates = new NativeReplyGates();
  gates.markSeen("m1", Date.now() - 60_000);
  gates.recordReply("u", Date.now() - 5_000);
  assert.equal(await dispatchNativeMessage({
    ...value, gates,
    prepareAttachment: async () => ({ body: value.message.body ?? "", pending: false }),
  }), "pending");
  assert.equal(value.runs.length, 0);
  assert.equal(value.state.get("m1")?.state, "received");
});
monitorTest("an uncertain outcome opens the circuit for the whole account", async t => {
  const value = monitorFixture(t);
  value.state.accept("1", value.message, "live");
  const gates = new NativeReplyGates();
  gates.markSeen("m1", Date.now() - 60_000);
  gates.tripCircuit();
  assert.equal(await dispatchNativeMessage({
    ...value, gates,
    prepareAttachment: async () => ({ body: value.message.body ?? "", pending: false }),
  }), "pending");
  assert.equal(value.runs.length, 0);
  assert.equal(value.state.get("m1")?.state, "received");
});
