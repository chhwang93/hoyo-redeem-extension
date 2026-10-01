import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, normalizeCodes, normalizeMeta, clampInterval, DEFAULT_SETTINGS, loadAll, saveAll } from "../hoyo-auto-redeem/storage.js";

// 1.0(원신 전용)이 실제로 저장하던 형식
const v1 = {
  settings: { uid: "836280000", region: "os_asia", accountSource: "auto", intervalMinutes: 10, lang: "ko", sources: { hoyoCodes: true, fandom: true }, transport: "auto" },
  codes: { OPERACOLLAB: { status: "used", retcode: -2017, attempts: 0 }, EPIC2026: { status: "success", retcode: 0, attempts: 0 } },
  meta: { transport: "fetch", login: { state: "ok" }, account: { uid: "836280000", region: "os_asia", nickname: "루미네", level: 60 } },
};

test("1.0 설정: UID와 서버를 원신 계정으로 옮기고 다른 설정은 유지", () => {
  const settings = normalizeSettings(v1.settings);
  assert.deepEqual(settings.accounts.genshin, { uid: "836280000", region: "os_asia", source: "auto" });
  assert.deepEqual(settings.accounts.hkrpg, { uid: "", region: "", source: "" });
  assert.deepEqual(settings.games, { genshin: true, hkrpg: true, nap: true });
  assert.equal(settings.intervalMinutes, 10);
  assert.ok(!("uid" in settings) && !("accountSource" in settings));
});

test("1.0 기록: 원신 기록으로 옮긴다", () => {
  const codes = normalizeCodes(v1.codes);
  assert.deepEqual(Object.keys(codes), ["genshin", "hkrpg", "nap"]);
  assert.equal(codes.genshin.EPIC2026.status, "success");
  assert.deepEqual(codes.hkrpg, {});
  assert.deepEqual(normalizeCodes(codes), codes, "새 형식은 그대로");
  assert.deepEqual(normalizeCodes(undefined), { genshin: {}, hkrpg: {}, nap: {} });
});

test("1.0 meta: 원신 캐릭터 정보를 roles.genshin으로", () => {
  const meta = normalizeMeta(v1.meta);
  assert.equal(meta.roles.genshin.nickname, "루미네");
  assert.equal(meta.transport, "fetch");
  assert.ok(!("account" in meta));
});

test("기본값과 주기 범위", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.equal(clampInterval("3"), 10);
  assert.equal(clampInterval(5000), 1440);
  assert.equal(clampInterval("abc"), 30);
});

// chrome.storage.local 흉내: get(문자열|배열), set(객체)
function fakeChromeStorage(initial) {
  const data = structuredClone(initial);
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
        set: async (patch) => Object.assign(data, structuredClone(patch)),
      },
    },
  };
  return data;
}

test("저장소 왕복: 1.0 데이터를 새 형식으로 저장하고, 게임 하나의 계정만 바꿔도 다른 계정은 남는다", async () => {
  const data = fakeChromeStorage(v1);
  try {
    await saveAll(await loadAll()); // 확장을 새로고침할 때 하는 일
    assert.deepEqual(data.settings.accounts.genshin, { uid: "836280000", region: "os_asia", source: "auto" });
    assert.ok(!("uid" in data.settings));
    assert.equal(data.codes.genshin.EPIC2026.status, "success");
    assert.equal(data.meta.roles.genshin.nickname, "루미네");

    await saveAll({ settings: { accounts: { hkrpg: { uid: "801234567", region: "prod_official_asia", source: "manual" } } } });
    const { settings } = await loadAll();
    assert.equal(settings.accounts.genshin.uid, "836280000");
    assert.equal(settings.accounts.hkrpg.uid, "801234567");
    assert.equal(settings.intervalMinutes, 10);
  } finally {
    delete globalThis.chrome;
  }
});

test("formatShortTime: 오늘이면 시:분, 다른 날이면 월/일", async () => {
  const { formatShortTime } = await import("../hoyo-auto-redeem/storage.js");
  const now = new Date(2026, 9, 2, 13, 0);
  assert.equal(formatShortTime(new Date(2026, 9, 2, 0, 49).toISOString(), now), "00:49");
  assert.equal(formatShortTime(new Date(2026, 9, 1, 20, 3).toISOString(), now), "10/1");
  assert.equal(formatShortTime(null, now), "-");
});
