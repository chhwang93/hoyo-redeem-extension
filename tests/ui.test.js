import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { send } from "../hoyo-auto-redeem/ui.js";

afterEach(() => {
  delete globalThis.chrome;
});

const fakeChrome = (sendMessage) => {
  globalThis.chrome = { runtime: { sendMessage } };
};

test("send: 응답을 그대로 돌려준다", async () => {
  fakeChrome(async (msg) => ({ ok: true, echo: msg }));
  assert.deepEqual(await send("runNow", { a: 1 }), { ok: true, echo: { type: "runNow", a: 1 } });
});

test("send: 백그라운드가 옛 버전이라 응답이 비면 새로고침하라고 알려 준다", async () => {
  fakeChrome(async () => undefined);
  assert.match((await send("detectAccounts")).error, /새로고침/);
});

test("send: 받는 쪽이 없어서 실패해도 예외 대신 error", async () => {
  fakeChrome(async () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });
  const res = await send("detectAccounts");
  assert.match(res.error, /새로고침/);
  assert.match(res.error, /Receiving end does not exist/);
});

test("entryMessage: 응답 코드 숫자는 알 수 없는 응답일 때만 보인다", async () => {
  const { entryMessage } = await import("../hoyo-auto-redeem/ui.js");
  assert.equal(entryMessage({ status: "used", retcode: -2017, message: "이미 사용된 코드입니다" }), "이미 사용된 코드입니다");
  assert.equal(entryMessage({ status: "success", retcode: 0, message: "OK" }), "");
  assert.equal(entryMessage({ status: "unknown", retcode: -9999, message: "?" }), "? (응답 코드 -9999)");
  assert.equal(entryMessage({ status: "gave_up", retcode: -9999, message: "" }), "(응답 코드 -9999)");
});
