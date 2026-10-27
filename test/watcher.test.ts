import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FakeDrafter } from "../src/agent/drafter.ts";
import { MockCafe24Client } from "../src/cafe24/mock.ts";
import { ROOT } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Watcher } from "../src/watcher.ts";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cs-watch-"));
  store = new Store(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const drafter = new FakeDrafter(() => ({
  category: "기타", answer: "안녕하세요, 고객님.\n데모몰 CS팀 드림", confidence: "high",
  needs_human: false, human_reasons: [], sources: [], internal_note: "",
}));

test("지금 확인: 새 글을 가져오고 초안을 만들기 시작한다", async () => {
  const pipeline = new Pipeline(store, new MockCafe24Client(path.join(ROOT, "data/mock"), { drip: 1 }), drafter, 2);
  const watcher = new Watcher(pipeline, store, 60);
  assert.deepEqual(await watcher.checkNow(), { added: 1, error: null });
  await pipeline.draftPending();
  assert.equal(store.countByStatus().drafted, 1);
  const status = watcher.status;
  assert.equal(status.lastAdded, 1);
  assert.ok(status.lastCheckedAt);
  assert.equal(status.checking, false);
});

test("같은 확인 실패는 알림을 한 번만 남기고, 다시 되면 실패 표시를 지운다", async () => {
  const mock = new MockCafe24Client(path.join(ROOT, "data/mock"));
  const original = mock.listNewReviews.bind(mock);
  mock.listNewReviews = async () => {
    throw new Error("카페24 API 401: invalid_token");
  };
  const pipeline = new Pipeline(store, mock, drafter, 2);
  const watcher = new Watcher(pipeline, store, 60);
  // 후기만 실패하고 문의 16건·댓글 3건은 저장된다.
  assert.deepEqual(await watcher.checkNow(), { added: 19, error: "카페24 API 401: invalid_token" });
  await watcher.checkNow();
  const failed = store.notificationsAfter(0, 500).filter((n) => n.type === "sync_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].article_no, null);
  assert.equal(watcher.status.lastError, "카페24 API 401: invalid_token");

  mock.listNewReviews = original;
  assert.equal((await watcher.checkNow()).error, null);
  assert.equal(watcher.status.lastError, null);
  await pipeline.draftPending();
});

test("동시에 두 번 눌러도 한 번만 확인한다", async () => {
  const mock = new MockCafe24Client(path.join(ROOT, "data/mock"));
  let calls = 0;
  const original = mock.listUnansweredInquiries.bind(mock);
  mock.listUnansweredInquiries = async () => {
    calls++;
    return original();
  };
  const pipeline = new Pipeline(store, mock, drafter, 2);
  const watcher = new Watcher(pipeline, store, 60);
  const [a, b] = await Promise.all([watcher.checkNow(), watcher.checkNow()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  await pipeline.draftPending();
});

test("간격이 0이면 start해도 확인하지 않는다", async () => {
  const pipeline = new Pipeline(store, new MockCafe24Client(path.join(ROOT, "data/mock")), drafter, 2);
  const watcher = new Watcher(pipeline, store, 0);
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(watcher.status.lastCheckedAt, null);
  assert.equal(store.countByStatus().new, 0);
  watcher.stop();
});

test("start하면 바로 한 번 확인하고 다음 확인 시각을 잡는다. stop하면 멈춘다", async () => {
  const pipeline = new Pipeline(store, new MockCafe24Client(path.join(ROOT, "data/mock")), drafter, 2);
  const watcher = new Watcher(pipeline, store, 60);
  watcher.start();
  for (let i = 0; i < 50 && !watcher.status.nextCheckAt; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(watcher.status.lastCheckedAt);
  assert.ok(Date.parse(watcher.status.nextCheckAt!) > Date.now() + 50_000);
  watcher.stop();
  assert.equal(watcher.status.nextCheckAt, null);
  await pipeline.draftPending();
});
