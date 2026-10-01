import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCheck,
  testConnection,
  detectAccounts,
  redeemOne,
  MAX_ATTEMPTS,
  MAX_CODES_PER_GAME,
  LOGIN_RECHECK_MS,
  NO_ROLE_RECHECK_MS,
  VERIFY_BACKOFF_MS,
} from "../genshin-auto-redeem/runner.js";
import { ROLES_URL, MIN_GAP_MS } from "../genshin-auto-redeem/redeem.js";
import { GAMES, GAME_IDS } from "../genshin-auto-redeem/games.js";
import { hoyoCodesUrl, wikiUrl } from "../genshin-auto-redeem/sources.js";
import { normalizeSettings, normalizeCodes, normalizeMeta } from "../genshin-auto-redeem/storage.js";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const HALF_HOUR = 30 * 60 * 1000;
const ROLES = {
  hk4e_global: { os_asia: [{ game_uid: 812345678, region: "os_asia", nickname: "루미네", level: 60 }] },
  hkrpg_global: { prod_official_asia: [{ game_uid: 801234567, region: "prod_official_asia", nickname: "개척자", level: 70 }] },
  nap_global: { prod_gf_jp: [{ game_uid: 1300000001, region: "prod_gf_jp", nickname: "프록시", level: 55 }] },
};
const ONLY_GENSHIN = { genshin: true, hkrpg: false, nap: false };
const GENSHIN_ACCOUNT = { genshin: { uid: "812345678", region: "os_asia", source: "manual" } };

/**
 * 가짜 HoYoverse API.
 * cookies: 방식마다 쿠키가 실리는지. 실행 중에 바꿔서 로그아웃을 흉내 낼 수 있다.
 * redeemCookies(mode, game): 교환 주소만 따로 쿠키 여부를 정할 때 (기본은 cookies를 따름)
 */
function fakeHoyo({ fetchCookies = true, tabCookies = true, redeemCookies, roles = ROLES, redeem = () => ({ retcode: 0, message: "OK" }) } = {}) {
  const calls = [];
  const closed = [];
  const cookies = { fetch: fetchCookies, tab: tabCookies };
  function handle(mode, request) {
    const url = new URL(request.url);
    if (request.url.startsWith(ROLES_URL)) {
      const gameBiz = url.searchParams.get("game_biz");
      const region = url.searchParams.get("region");
      calls.push({ mode, kind: "roles", game: GAME_IDS.find((id) => GAMES[id].gameBiz === gameBiz), region });
      if (!cookies[mode]) return { retcode: -100, message: "Login expired. Please log in again.", data: null };
      return { retcode: 0, message: "OK", data: { list: roles[gameBiz]?.[region] ?? [] } };
    }
    const game = GAME_IDS.find((id) => request.url.startsWith(GAMES[id].redeemUrl));
    const params = request.method === "GET" ? Object.fromEntries(url.searchParams) : JSON.parse(request.body);
    calls.push({ mode, kind: "redeem", game, params });
    const loggedIn = redeemCookies ? redeemCookies(mode, game) : cookies[mode];
    if (!loggedIn) return { retcode: -1071, message: "계정을 먼저 로그인해 주세요", data: null };
    return { data: null, ...redeem(game, params.cdkey) };
  }
  return {
    calls,
    closed,
    cookies,
    redeems: () => calls.filter((c) => c.kind === "redeem"),
    makeTransport: (mode) => ({ mode, call: async (request) => handle(mode, request), close: async () => closed.push(mode) }),
  };
}

/**
 * @param {object} o
 * @param {Record<string, string[]>} o.codes  게임별 hoyo-codes 응답
 * @param {Record<string, string>} [o.wikiHtml]  게임별 위키 Active/All Codes HTML. 없으면 위키는 403
 */
function makeDeps({ hoyo, codes = {}, wikiHtml = {}, storage = {} }) {
  let now = T0;
  const store = {
    settings: normalizeSettings(storage.settings),
    codes: normalizeCodes(storage.codes),
    meta: normalizeMeta(storage.meta),
  };
  const deps = {
    store,
    sleeps: [],
    notifications: [],
    sourceRequests: [],
    load: async () => structuredClone(store),
    save: async ({ settings, codes: c, meta }) => {
      if (settings) store.settings = normalizeSettings({ ...store.settings, ...settings, accounts: { ...store.settings.accounts, ...settings.accounts } });
      if (c) store.codes = structuredClone(c);
      if (meta) store.meta = structuredClone(meta);
    },
    makeTransport: hoyo.makeTransport,
    fetchImpl: async (url) => {
      deps.sourceRequests.push(url);
      for (const id of GAME_IDS) {
        if (url === hoyoCodesUrl(id)) {
          const body = { codes: (codes[id] ?? []).map((code) => ({ code, status: "OK", game: GAMES[id].hoyoCodes })) };
          return { ok: true, status: 200, json: async () => body };
        }
        if (url === wikiUrl(id)) {
          if (!wikiHtml[id]) return { ok: false, status: 403, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ parse: { text: wikiHtml[id] } }) };
        }
      }
      throw new Error(url);
    },
    notify: async (kind, data) => deps.notifications.push([kind, data]),
    clock: () => now,
    sleep: async (ms) => {
      deps.sleeps.push(ms);
      now += ms;
    },
    advance: (ms) => (now += ms),
    newDeviceId: () => "device-1",
    keepAlives: 0,
    keepAlive: async () => {
      deps.keepAlives++;
    },
    throttle: { last: 0 },
  };
  return deps;
}

const status = (deps, game, code) => deps.store.codes[game][code]?.status;

test("첫 실행: 세 게임 계정을 찾아서 코드별로 교환하고 한 번에 알린다", async () => {
  const hoyo = fakeHoyo({
    redeem: (game, code) => (code.startsWith("USED") ? { retcode: -2017, message: "이미 사용된 코드입니다" } : { retcode: 0, message: "OK" }),
  });
  const deps = makeDeps({ hoyo, codes: { genshin: ["GENSHIN01", "USEDCODE1"], hkrpg: ["STARRAIL01"], nap: ["ZENLESS01"] } });
  const summary = await runCheck(deps);

  assert.equal(summary.attempted, 4);
  assert.deepEqual(summary.successes, [
    { game: "genshin", code: "GENSHIN01" },
    { game: "hkrpg", code: "STARRAIL01" },
    { game: "nap", code: "ZENLESS01" },
  ]);
  assert.equal(status(deps, "genshin", "USEDCODE1"), "used");
  assert.deepEqual(deps.store.settings.accounts.hkrpg, { uid: "801234567", region: "prod_official_asia", source: "auto" });
  assert.deepEqual(deps.store.settings.accounts.nap, { uid: "1300000001", region: "prod_gf_jp", source: "auto" });
  assert.equal(deps.store.meta.roles.nap.nickname, "프록시");
  assert.equal(deps.store.meta.transport, "fetch");
  assert.equal(deps.store.meta.login.state, "ok");
  assert.deepEqual(deps.notifications, [["success", summary.successes]]);

  // 스타레일은 JSON POST, 기기 ID는 한 번 만들어서 저장해 둔다
  const hsr = hoyo.redeems().find((c) => c.game === "hkrpg");
  assert.equal(hsr.params.device_uuid, "device-1");
  assert.equal(hsr.params.platform, "4");
  assert.equal(deps.store.meta.deviceId, "device-1");
  // 계정 조회 3번 + 교환 4번, 사이마다 5.5초, 요청 전마다 서비스 워커 붙잡기
  assert.equal(hoyo.calls.length, 7);
  assert.ok(deps.sleeps.every((ms) => ms === MIN_GAP_MS));
  assert.equal(deps.sleeps.length, 6);
  assert.equal(deps.keepAlives, 7);
});

test("결과가 정해진 코드는 다시 시도하지 않고, 새 코드가 없으면 HoYoverse API를 부르지 않는다", async () => {
  const hoyo = fakeHoyo();
  const deps = makeDeps({ hoyo, codes: { genshin: ["CODE00001", "CODE00002"] }, storage: { settings: { games: ONLY_GENSHIN } } });
  await runCheck(deps);
  assert.equal(hoyo.redeems().length, 2);

  deps.advance(HALF_HOUR);
  const second = await runCheck(deps);
  assert.equal(second.candidates, 0);
  assert.equal(hoyo.redeems().length, 2);
  assert.equal(hoyo.calls.length, 3);
  assert.equal(deps.sourceRequests.length, 4, "확인마다 켜 둔 게임 × 출처 2곳");
});

test("꺼 둔 게임은 코드도 받아 오지 않는다", async () => {
  const hoyo = fakeHoyo();
  const deps = makeDeps({ hoyo, codes: { genshin: ["CODE00001"], nap: ["ZENLESS01"] }, storage: { settings: { games: ONLY_GENSHIN } } });
  await runCheck(deps);
  assert.ok(deps.sourceRequests.every((url) => url.includes("genshin")));
  assert.ok(hoyo.calls.every((c) => c.game === "genshin"));
});

test("서비스 워커 fetch에 쿠키가 안 실리면 탭으로 바꾼다", async () => {
  const hoyo = fakeHoyo({ fetchCookies: false });
  const deps = makeDeps({ hoyo, codes: { genshin: ["CODE00001", "CODE00002"] }, storage: { settings: { games: ONLY_GENSHIN } } });
  const summary = await runCheck(deps);

  assert.equal(summary.successes.length, 2);
  assert.equal(deps.store.meta.transport, "tab");
  assert.deepEqual(hoyo.calls.map((c) => c.mode), ["fetch", "tab", "tab", "tab"]);
  assert.ok(hoyo.closed.includes("tab"), "탭은 확인이 끝나면 닫는다");

  deps.advance(HALF_HOUR);
  hoyo.calls.length = 0;
  const next = makeDeps({ hoyo, codes: { genshin: ["CODE00003"] } });
  await runCheck({ ...deps, fetchImpl: next.fetchImpl });
  assert.deepEqual(hoyo.calls.map((c) => c.mode), ["tab"], "다음부터는 탭만");
});

test("로그인 필요: 교환하지 않고 멈추고, 한 번만 알리고, 1시간은 자동으로 다시 확인하지 않는다", async () => {
  const hoyo = fakeHoyo({ fetchCookies: false, tabCookies: false });
  const deps = makeDeps({ hoyo, codes: { genshin: ["CODE00001"], hkrpg: ["STARRAIL01"] } });
  const summary = await runCheck(deps);

  assert.equal(summary.stopReason, "login_required");
  assert.equal(hoyo.redeems().length, 0);
  assert.equal(status(deps, "genshin", "CODE00001"), "new");
  assert.ok(hoyo.calls.every((c) => c.game === "genshin"), "첫 게임에서 멈추고 다음 게임은 건드리지 않는다");
  assert.deepEqual(deps.notifications, [["login", { game: "genshin" }]]);

  deps.advance(HALF_HOUR);
  const before = hoyo.calls.length;
  await runCheck(deps);
  assert.equal(hoyo.calls.length, before);
  assert.equal(deps.notifications.length, 1);

  await runCheck(deps, { manual: true });
  assert.ok(hoyo.calls.length > before, "수동 확인은 바로 확인");

  deps.advance(LOGIN_RECHECK_MS);
  const later = hoyo.calls.length;
  await runCheck(deps);
  assert.ok(hoyo.calls.length > later);
});

test("교환 중에 로그아웃되면 모든 게임을 멈추고 남은 코드는 대기로 둔다", async () => {
  const hoyo = fakeHoyo({
    redeem: () => {
      hoyo.cookies.fetch = false; // 첫 교환 직후 로그아웃
      return { retcode: 0 };
    },
  });
  const deps = makeDeps({
    hoyo,
    codes: { genshin: ["CODE00001", "CODE00002", "CODE00003"], hkrpg: ["STARRAIL01"] },
    storage: {
      settings: { transport: "fetch", accounts: { ...GENSHIN_ACCOUNT, hkrpg: { uid: "801234567", region: "prod_official_asia" } } },
    },
  });
  const summary = await runCheck(deps);
  assert.equal(summary.stopReason, "login_required");
  assert.equal(status(deps, "genshin", "CODE00001"), "success");
  assert.equal(status(deps, "genshin", "CODE00002"), "login_required");
  assert.equal(status(deps, "genshin", "CODE00003"), "new");
  assert.equal(status(deps, "hkrpg", "STARRAIL01"), "new");
  assert.deepEqual(deps.notifications.map((x) => x[0]), ["success", "login"]);
});

test("요청 제한(-2016)이면 멈추고 다음 확인 때 다시 한다", async () => {
  let limited = true;
  const hoyo = fakeHoyo({ redeem: () => (limited ? { retcode: -2016, message: "쿨다운" } : { retcode: 0 }) });
  const deps = makeDeps({
    hoyo,
    codes: { genshin: ["CODE00001", "CODE00002"] },
    storage: { settings: { games: ONLY_GENSHIN, accounts: GENSHIN_ACCOUNT }, meta: { transport: "fetch" } },
  });
  assert.equal((await runCheck(deps)).stopReason, "cooldown");
  assert.equal(hoyo.redeems().length, 1);

  limited = false;
  deps.advance(HALF_HOUR);
  assert.equal((await runCheck(deps)).successes.length, 2);
});

test("보안 확인이 뜨면 받은 걸로 치지 않고, 그 게임만 멈추고 알린다", async () => {
  const verify = { retcode: 0, message: "OK", data: { msg: "", gee_test_param: { should_pop_verify: true, token: "t", verify_str: "{}" } } };
  const hoyo = fakeHoyo({ redeem: (game) => (game === "hkrpg" ? verify : { retcode: 0, message: "OK" }) });
  const deps = makeDeps({ hoyo, codes: { hkrpg: ["STARRAIL01", "STARRAIL02"], nap: ["ZENLESS01"] } });
  const summary = await runCheck(deps);

  assert.equal(status(deps, "hkrpg", "STARRAIL01"), "verify_required");
  assert.equal(status(deps, "hkrpg", "STARRAIL02"), "new", "같은 게임의 남은 코드는 다음 확인으로");
  assert.equal(status(deps, "nap", "ZENLESS01"), "success", "다른 게임은 계속");
  assert.deepEqual(summary.verify, [{ game: "hkrpg", code: "STARRAIL01" }]);
  assert.deepEqual(deps.notifications, [
    ["success", [{ game: "nap", code: "ZENLESS01" }]],
    ["verify", { game: "hkrpg", code: "STARRAIL01" }],
  ]);

  const hsrRedeems = (code) => hoyo.redeems().filter((c) => c.params.cdkey === code).length;
  deps.advance(HALF_HOUR);
  await runCheck(deps);
  assert.equal(hsrRedeems("STARRAIL01"), 1, "직접 입력 필요는 다시 시도하지 않는다");
  assert.equal(hsrRedeems("STARRAIL02"), 0, "보안 확인이 뜬 게임은 한동안 쉰다");

  deps.advance(VERIFY_BACKOFF_MS);
  await runCheck(deps);
  assert.equal(hsrRedeems("STARRAIL02"), 1);
});

test("캐릭터가 없는 게임은 건너뛰고, 하루 동안은 다시 찾지 않는다", async () => {
  const hoyo = fakeHoyo({ roles: { hk4e_global: ROLES.hk4e_global } });
  const deps = makeDeps({ hoyo, codes: { genshin: ["CODE00001"], nap: ["ZENLESS01"] }, storage: { settings: { games: { genshin: true, hkrpg: false, nap: true } } } });
  const summary = await runCheck(deps);

  assert.deepEqual(summary.successes, [{ game: "genshin", code: "CODE00001" }]);
  assert.equal(status(deps, "nap", "ZENLESS01"), "new");
  assert.equal(hoyo.calls.filter((c) => c.game === "nap").length, 4, "젠존제 서버 4곳을 조회");
  assert.ok(deps.store.meta.noRole.nap);

  deps.advance(HALF_HOUR);
  const before = hoyo.calls.length;
  await runCheck(deps);
  assert.equal(hoyo.calls.length, before, "하루 안에는 다시 찾지 않는다");

  deps.advance(NO_ROLE_RECHECK_MS);
  await runCheck(deps);
  assert.equal(hoyo.calls.length, before + 4);
});

test("알 수 없는 retcode는 MAX_ATTEMPTS번 뒤 그만둔다", async () => {
  const hoyo = fakeHoyo({ redeem: () => ({ retcode: -9999, message: "?" }) });
  const deps = makeDeps({
    hoyo,
    codes: { genshin: ["WEIRDCODE"] },
    storage: { settings: { games: ONLY_GENSHIN, accounts: GENSHIN_ACCOUNT }, meta: { transport: "fetch" } },
  });
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await runCheck(deps);
    deps.advance(HALF_HOUR);
  }
  assert.equal(hoyo.redeems().length, MAX_ATTEMPTS);
  assert.equal(status(deps, "genshin", "WEIRDCODE"), "gave_up");
});

test("계정과 요청 방식을 알면 바로 교환하고, 수동 확인은 첫 게임에서 로그인을 한 번 확인한다", async () => {
  const hoyo = fakeHoyo();
  const accounts = { ...GENSHIN_ACCOUNT, hkrpg: { uid: "801234567", region: "prod_official_asia" } };
  const deps = makeDeps({ hoyo, codes: { genshin: ["CODE00001"] }, storage: { settings: { games: { genshin: true, hkrpg: true, nap: false }, accounts }, meta: { transport: "fetch" } } });
  await runCheck(deps);
  assert.deepEqual(hoyo.calls.map((c) => c.kind), ["redeem"]);

  deps.advance(60 * 1000);
  await runCheck(deps, { manual: true });
  assert.deepEqual(hoyo.calls.slice(1).map((c) => `${c.kind}:${c.game}`), ["roles:genshin"]);
});

test("fetch로 되던 환경에서 교환이 로그인 오류면 탭으로 같은 요청을 다시 보낸다", async () => {
  const hoyo = fakeHoyo({ fetchCookies: false });
  const deps = makeDeps({
    hoyo,
    codes: { genshin: ["CODE00001"] },
    storage: { settings: { games: ONLY_GENSHIN, accounts: GENSHIN_ACCOUNT }, meta: { transport: "fetch" } },
  });
  assert.equal((await runCheck(deps)).successes.length, 1);
  assert.equal(deps.store.meta.transport, "tab");
  assert.deepEqual(hoyo.calls.map((c) => `${c.mode}:${c.kind}`), ["fetch:redeem", "tab:redeem"]);
});

const KNOWN_ACCOUNTS = {
  ...GENSHIN_ACCOUNT,
  hkrpg: { uid: "801234567", region: "prod_official_asia", source: "auto" },
  nap: { uid: "1300000001", region: "prod_gf_jp", source: "auto" },
};

test("스타레일 교환만 바로 요청에서 로그인이 안 잡히면 탭으로 보내고 계속한다", async () => {
  const hoyo = fakeHoyo({ redeemCookies: (mode, game) => !(mode === "fetch" && game === "hkrpg") });
  const deps = makeDeps({ hoyo, codes: { genshin: ["CODE00001"], hkrpg: ["STARRAIL01"] }, storage: { settings: { accounts: KNOWN_ACCOUNTS }, meta: { transport: "fetch" } } });
  const summary = await runCheck(deps);
  assert.equal(summary.successes.length, 2);
  assert.deepEqual(hoyo.calls.map((c) => `${c.mode}:${c.game}`), ["fetch:genshin", "fetch:hkrpg", "tab:hkrpg"]);
  assert.equal(deps.store.meta.login.state, "ok");
});

test("교환만 로그인 오류이고 계정 조회는 되면 그 게임만 멈추고 로그인 상태는 건드리지 않는다", async () => {
  const hoyo = fakeHoyo({ redeemCookies: (_mode, game) => game !== "hkrpg" });
  const deps = makeDeps({ hoyo, codes: { hkrpg: ["STARRAIL01", "STARRAIL02"], nap: ["ZENLESS01"] }, storage: { settings: { accounts: KNOWN_ACCOUNTS }, meta: { transport: "fetch", login: { state: "ok" } } } });
  const summary = await runCheck(deps);
  assert.equal(summary.stopReason, null);
  assert.equal(status(deps, "hkrpg", "STARRAIL01"), "account_error");
  assert.equal(status(deps, "hkrpg", "STARRAIL02"), "new");
  assert.equal(status(deps, "nap", "ZENLESS01"), "success");
  assert.equal(deps.store.meta.login.state, "ok");
  assert.ok(!deps.notifications.some(([kind]) => kind === "login"));
});

test("한 게임의 서버 오류는 그 게임만 멈춘다", async () => {
  const hoyo = fakeHoyo({ redeem: (game) => (game === "hkrpg" ? { error: "http", httpStatus: 403, message: "HTTP 403" } : { retcode: 0 }) });
  const deps = makeDeps({ hoyo, codes: { hkrpg: ["STARRAIL01", "STARRAIL02"], nap: ["ZENLESS01"] }, storage: { settings: { accounts: KNOWN_ACCOUNTS }, meta: { transport: "fetch" } } });
  const summary = await runCheck(deps);
  assert.equal(summary.stopReason, null);
  assert.equal(status(deps, "hkrpg", "STARRAIL01"), "server_error");
  assert.equal(status(deps, "hkrpg", "STARRAIL02"), "new");
  assert.equal(status(deps, "nap", "ZENLESS01"), "success");
});

test("한 번의 확인에서 게임마다 20개까지만 보낸다", async () => {
  const hoyo = fakeHoyo();
  const codes = Array.from({ length: MAX_CODES_PER_GAME + 5 }, (_, i) => `BULKCODE${String(i).padStart(3, "0")}`);
  const deps = makeDeps({ hoyo, codes: { genshin: codes }, storage: { settings: { games: ONLY_GENSHIN, accounts: GENSHIN_ACCOUNT }, meta: { transport: "fetch" } } });
  await runCheck(deps);
  assert.equal(hoyo.redeems().length, MAX_CODES_PER_GAME);
  deps.advance(HALF_HOUR);
  await runCheck(deps);
  assert.equal(hoyo.redeems().length, MAX_CODES_PER_GAME + 5);
});

test("서버를 판별할 수 없는 계정이면 위키 서버 정보로 거르지 않는다", async () => {
  const hoyo = fakeHoyo();
  const html = `<h2><span id="Active_Codes">A</span></h2><table class="wikitable"><tr><th>Code</th><th>Server</th><th>Rewards</th><th>Duration</th></tr>
    <tr><td><code>ASIAONLY01</code></td><td>Asia</td><td></td><td>Discovered: May 1, 2026</td></tr></table>`;
  const deps = makeDeps({
    hoyo,
    wikiHtml: { genshin: html },
    storage: { settings: { games: ONLY_GENSHIN, accounts: { genshin: { uid: "812345678", region: "os_somewhere" } } }, meta: { transport: "fetch" } },
  });
  await runCheck(deps);
  assert.equal(hoyo.redeems().length, 1);
  assert.equal(status(deps, "genshin", "ASIAONLY01"), "success");
});

test("자동으로 찾은 계정은 로그인 계정이 바뀌면 따라가고, 직접 입력한 계정은 그대로 둔다", async () => {
  const roles = {
    ...ROLES,
    hk4e_global: { os_asia: [{ game_uid: 899999999, region: "os_asia", nickname: "새계정", level: 1 }] },
    hkrpg_global: { prod_official_asia: [{ game_uid: 809999999, region: "prod_official_asia", nickname: "새계정", level: 1 }] },
  };
  for (const [source, expected] of [["auto", "899999999"], ["manual", "812345678"]]) {
    const hoyo = fakeHoyo({ roles });
    const accounts = { genshin: { uid: "812345678", region: "os_asia", source } };
    const deps = makeDeps({ hoyo, storage: { settings: { games: ONLY_GENSHIN, accounts }, meta: { transport: "fetch" } } });
    await runCheck(deps, { manual: true });
    assert.equal(deps.store.settings.accounts.genshin.uid, expected, source);
  }
});

test("위키에 다른 서버 전용으로 나온 코드는 요청하지 않는다", async () => {
  const hoyo = fakeHoyo();
  const html = `<h2><span id="Active_Codes">A</span></h2><table class="wikitable"><tr><th>Code</th><th>Server</th><th>Rewards</th><th>Duration</th></tr>
    <tr><td><code>ASIAONLY01</code></td><td>Asia</td><td></td><td>Discovered: May 1, 2026</td></tr></table>`;
  const deps = makeDeps({
    hoyo,
    wikiHtml: { genshin: html },
    storage: { settings: { games: ONLY_GENSHIN, accounts: { genshin: { uid: "612345678", region: "os_usa" } } }, meta: { transport: "fetch" } },
  });
  await runCheck(deps);
  assert.equal(hoyo.calls.length, 0);
  assert.equal(status(deps, "genshin", "ASIAONLY01"), "region_locked");
});

test("출처 하나가 실패해도 진행하고 로그에 남긴다", async () => {
  const hoyo = fakeHoyo();
  const deps = makeDeps({ hoyo, codes: { genshin: ["CODE00001"] }, storage: { settings: { games: ONLY_GENSHIN } } });
  const summary = await runCheck(deps);
  assert.equal(summary.successes.length, 1);
  assert.deepEqual(summary.sourceErrors, [{ game: "genshin", source: "fandom", message: "HTTP 403" }]);
  assert.ok(deps.store.meta.log.some((l) => l.level === "warn" && l.msg.includes("Fandom")));
});

test("연결 확인: 두 방식 결과를 돌려주고 되는 쪽을 저장한다", async () => {
  const hoyo = fakeHoyo({ fetchCookies: false });
  const deps = makeDeps({ hoyo });
  const r = await testConnection(deps);
  assert.equal(r.results.fetch.kind, "login_required");
  assert.equal(r.results.tab.kind, "ok");
  assert.equal(r.working, "tab");
  assert.equal(deps.store.meta.transport, "tab");
  assert.deepEqual(hoyo.closed, ["fetch", "tab"]);
});

test("계정 다시 찾기: 저장된 UID를 무시하고 켜 둔 게임마다 새로 찾는다", async () => {
  const hoyo = fakeHoyo();
  const deps = makeDeps({ hoyo, storage: { settings: { accounts: { genshin: { uid: "612345678", region: "os_usa", source: "manual" } } } } });
  const r = await detectAccounts(deps);
  assert.deepEqual(r.genshin.account, { uid: "812345678", region: "os_asia" });
  assert.equal(r.nap.role.nickname, "프록시");
  assert.equal(deps.store.settings.accounts.genshin.source, "auto");
});

test("계정 다시 찾기: 캐릭터가 없는 게임은 예전 UID를 지운다", async () => {
  const hoyo = fakeHoyo({ roles: { hk4e_global: ROLES.hk4e_global } });
  const accounts = { nap: { uid: "1500000001", region: "prod_gf_eu", source: "manual" } };
  const deps = makeDeps({ hoyo, storage: { settings: { games: { genshin: true, hkrpg: false, nap: true }, accounts } } });
  const r = await detectAccounts(deps);
  assert.equal(r.nap.kind, "account_error");
  assert.deepEqual(deps.store.settings.accounts.nap, { uid: "", region: "", source: "" });
});

test("코드 직접 입력: retcode를 돌려주고 기록에 남긴다", async () => {
  const hoyo = fakeHoyo({ redeem: () => ({ retcode: -2017, message: "이미 사용된 코드입니다" }) });
  const deps = makeDeps({ hoyo, storage: { settings: { accounts: GENSHIN_ACCOUNT }, meta: { transport: "fetch" } } });
  const r = await redeemOne(deps, "genshin", " usedcode1 ");
  assert.equal(r.code, "USEDCODE1");
  assert.equal(r.retcode, -2017);
  assert.equal(r.kind, "used");
  assert.equal(status(deps, "genshin", "USEDCODE1"), "used");
  assert.ok((await redeemOne(deps, "genshin", "a b")).error);
  assert.ok((await redeemOne(deps, "nope", "ABCD1234")).error);
});
