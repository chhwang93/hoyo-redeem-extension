import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLES_URL,
  STATUS,
  RETCODES,
  buildRedeemRequest,
  buildRolesRequest,
  classifyResponse,
  pickRole,
  parseRawResponse,
  createFetchTransport,
} from "../hoyo-auto-redeem/redeem.js";
import { GAMES, regionFromUid, serverOf, giftPageUrl } from "../hoyo-auto-redeem/games.js";

const account = { uid: "812345678", region: "os_asia", lang: "ko", cdkey: "GENSHINGIFT", deviceId: "dev-1", now: 1790000000000 };

test("원신 교환: 공식 페이지와 같은 GET", () => {
  const req = buildRedeemRequest("genshin", account);
  const url = new URL(req.url);
  assert.equal(req.method, "GET");
  assert.equal(`${url.origin}${url.pathname}`, "https://public-operation-hk4e.hoyoverse.com/common/apicdkey/api/webExchangeCdkey");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    uid: "812345678",
    region: "os_asia",
    lang: "ko",
    cdkey: "GENSHINGIFT",
    game_biz: "hk4e_global",
  });
});

test("스타레일·젠존제 교환: webExchangeCdkeyRisk에 JSON POST", () => {
  for (const [gameId, host, gameBiz, region] of [
    ["hkrpg", "public-operation-hkrpg", "hkrpg_global", "prod_official_asia"],
    ["nap", "public-operation-nap", "nap_global", "prod_gf_jp"],
  ]) {
    const req = buildRedeemRequest(gameId, { ...account, region, cdkey: "TESTCODE01" });
    assert.equal(req.method, "POST");
    assert.equal(req.url, `https://${host}.hoyoverse.com/common/apicdkey/api/webExchangeCdkeyRisk`);
    assert.equal(req.headers["Content-Type"], "application/json");
    assert.equal(req.headers["x-rpc-language"], "ko");
    assert.deepEqual(JSON.parse(req.body), {
      t: 1790000000000,
      lang: "ko",
      game_biz: gameBiz,
      uid: "812345678",
      region,
      cdkey: "TESTCODE01",
      platform: "4",
      device_uuid: "dev-1",
    });
  }
});

test("캐릭터 조회 요청", () => {
  const url = new URL(buildRolesRequest("nap", { region: "prod_gf_us", lang: "ko" }).url);
  assert.equal(`${url.origin}${url.pathname}`, ROLES_URL);
  assert.deepEqual(Object.fromEntries(url.searchParams), { lang: "ko", region: "prod_gf_us", game_biz: "nap_global" });
});

test("classifyResponse: 실측한 응답", () => {
  // 원신, 로그인 상태 (2026-10-01)
  assert.equal(classifyResponse({ retcode: 0, message: "OK" }), "success");
  assert.equal(classifyResponse({ retcode: -2017, message: "이미 사용된 코드입니다" }), "used");
  assert.equal(classifyResponse({ retcode: -2001, message: "교환코드 기한 만료" }), "expired");
  // 스타레일·젠존제, 로그인 상태 (2026-10-01)
  assert.equal(classifyResponse(parseRawResponse({ status: 200, body: '{"retcode":0,"message":"OK","data":{"msg":"교환 성공~"}}' })), "success");
  assert.equal(classifyResponse({ retcode: -2018, message: "이미 사용된 리딤코드입니다" }), "used");
  assert.equal(classifyResponse({ retcode: -2001, message: "리딤코드 기한 만료" }), "expired");
  // 세 게임, 로그아웃 상태
  assert.equal(classifyResponse({ retcode: -1071, message: "계정을 먼저 로그인해 주세요" }), "login_required");
  assert.equal(classifyResponse({ retcode: -100, message: "Login expired. Please log in again." }), "login_required");
});

test("classifyResponse: 보안 확인이 뜨면 retcode 0이어도 받은 게 아니다", () => {
  const data = (verify) => ({ msg: "", gee_test_param: { should_pop_verify: verify, token: "t", verify_str: "{}" } });
  assert.equal(classifyResponse({ retcode: 0, data: data(true) }), "verify_required");
  assert.equal(classifyResponse({ retcode: 0, data: data(false) }), "success");
});

test("classifyResponse: 나머지 분류", () => {
  assert.equal(classifyResponse({ retcode: -2018 }), "used");
  assert.equal(classifyResponse({ retcode: -2003 }), "invalid");
  assert.equal(classifyResponse({ retcode: -2016 }), "cooldown");
  assert.equal(classifyResponse({ retcode: -99999 }), "unknown");
  assert.equal(classifyResponse({ error: "http", httpStatus: 429 }), "cooldown");
  assert.equal(classifyResponse({ error: "http", httpStatus: 502 }), "server_error", "HTTP 오류는 그 게임만 멈춘다");
  assert.equal(classifyResponse(parseRawResponse({ status: 200, body: "<html>" })), "server_error");
  assert.equal(classifyResponse({ error: "network" }), "network_error", "연결 실패는 전체를 멈춘다");
});

test("STATUS: 확정 상태와 멈춤 범위", () => {
  for (const kind of ["success", "used", "expired", "invalid", "verify_required"]) assert.equal(STATUS[kind].final, true, kind);
  for (const kind of ["login_required", "network_error", "cooldown"]) {
    assert.notEqual(STATUS[kind].final, true, kind);
    assert.equal(STATUS[kind].stop, "all", kind);
  }
  assert.equal(STATUS.account_error.stop, "game");
  assert.equal(STATUS.server_error.stop, "game");
  assert.equal(STATUS.verify_required.stop, "game");
  for (const kind of Object.values(RETCODES)) assert.ok(STATUS[kind], kind);
});

test("regionFromUid: 게임마다 앞자리 규칙이 다르다", () => {
  assert.equal(regionFromUid("genshin", "612345678"), "os_usa");
  assert.equal(regionFromUid("genshin", "812345678"), "os_asia");
  assert.equal(regionFromUid("genshin", "1812345678"), "os_asia");
  assert.equal(regionFromUid("genshin", "912345678"), "os_cht");
  assert.equal(regionFromUid("hkrpg", "712345678"), "prod_official_eur");
  assert.equal(regionFromUid("hkrpg", "812345678"), "prod_official_asia");
  assert.equal(regionFromUid("nap", "1312345678"), "prod_gf_jp");
  assert.equal(regionFromUid("nap", "1012345678"), "prod_gf_us");
  assert.equal(regionFromUid("nap", "812345678"), null);
  assert.equal(regionFromUid("genshin", "abc"), null);
});

test("serverOf / giftPageUrl", () => {
  assert.equal(serverOf("nap", "prod_gf_jp"), "asia");
  assert.equal(serverOf("hkrpg", "os_asia"), null);
  assert.equal(giftPageUrl("hkrpg", "ABC123DEF"), "https://hsr.hoyoverse.com/gift?code=ABC123DEF");
  assert.equal(giftPageUrl("nap"), GAMES.nap.giftPage);
});

test("pickRole: 공식 페이지처럼 list[0]", () => {
  const resp = { retcode: 0, data: { list: [{ game_uid: 812345678, region: "os_asia", nickname: "여행자", level: 60 }, { game_uid: 1 }] } };
  assert.deepEqual(pickRole(resp), { uid: "812345678", region: "os_asia", nickname: "여행자", level: 60 });
  assert.equal(pickRole({ retcode: 0, data: { list: [] } }), null);
  assert.equal(pickRole({ retcode: -100, data: null }), null);
});

test("parseRawResponse", () => {
  assert.deepEqual(parseRawResponse({ status: 200, body: '{"data":null,"message":"x","retcode":-1071}' }), { retcode: -1071, message: "x", data: null });
  assert.equal(parseRawResponse({ status: 200, body: '{"data":{"msg":"교환 성공"},"message":"OK","retcode":0}' }).message, "교환 성공");
  assert.equal(parseRawResponse({ status: 429, body: "" }).httpStatus, 429);
  assert.equal(parseRawResponse({ status: 200, body: "<html>" }).error, "http");
  assert.equal(parseRawResponse({ status: 0, body: "", error: "TypeError: Failed to fetch" }).error, "network");
  assert.equal(parseRawResponse(undefined).error, "network");
});

test("createFetchTransport: 쿠키를 싣고 method/body를 그대로 보낸다", async () => {
  let init;
  const transport = createFetchTransport(async (_url, i) => {
    init = i;
    return { status: 200, text: async () => '{"retcode":0,"message":"OK","data":null}' };
  });
  const req = buildRedeemRequest("hkrpg", { ...account, region: "prod_official_asia" });
  assert.deepEqual(await transport.call(req), { retcode: 0, message: "OK", data: null });
  assert.equal(init.credentials, "include");
  assert.equal(init.method, "POST");
  assert.equal(init.body, req.body);

  const failing = createFetchTransport(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(await failing.call(req), { error: "network", message: "Failed to fetch" });
});
