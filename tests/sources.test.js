import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeCode,
  parseHoyoCodes,
  parseWikiCodes,
  serversFromText,
  parseValidUntil,
  isExpired,
  mergeCodes,
  collectCodes,
  hoyoCodesUrl,
  wikiUrl,
} from "../genshin-auto-redeem/sources.js";

// 2026-10-01에 받아 둔 실제 응답. 스타레일 위키는 표 앞쪽 12행만 남겼다.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const hoyo = { genshin: fixture("hoyo-codes-genshin"), hkrpg: fixture("hoyo-codes-hkrpg"), nap: fixture("hoyo-codes-nap") };
const wiki = { genshin: fixture("wiki-genshin"), hkrpg: fixture("wiki-hkrpg"), nap: fixture("wiki-nap") };
const FIXTURE_DAY = new Date("2026-10-01T12:00:00Z");

test("normalizeCode: 공백 제거, 대문자, 형식 검사", () => {
  assert.equal(normalizeCode("  VesnaOnPatrol "), "VESNAONPATROL");
  assert.equal(normalizeCode("ABC"), null);
  assert.equal(normalizeCode("HAS SPACE1"), null);
  assert.equal(normalizeCode(undefined), null);
});

test("주소: 게임마다 hoyo-codes 파라미터와 위키 호스트가 다르다", () => {
  assert.equal(hoyoCodesUrl("genshin"), "https://hoyo-codes.seria.moe/codes?game=genshin");
  assert.equal(hoyoCodesUrl("hkrpg"), "https://hoyo-codes.seria.moe/codes?game=hkrpg");
  assert.equal(hoyoCodesUrl("nap"), "https://hoyo-codes.seria.moe/codes?game=nap");
  assert.match(wikiUrl("genshin"), /^https:\/\/genshin-impact\.fandom\.com\/api\.php\?action=parse&page=Promotional_Code&/);
  assert.match(wikiUrl("hkrpg"), /^https:\/\/honkai-star-rail\.fandom\.com\/api\.php\?action=parse&page=Redemption_Code&/);
  assert.match(wikiUrl("nap"), /^https:\/\/zenless-zone-zero\.fandom\.com\/api\.php\?action=parse&page=Redemption_Code&/);
});

test("parseHoyoCodes: 실제 응답", () => {
  assert.equal(parseHoyoCodes(hoyo.genshin, "genshin").length, 12);
  assert.ok(parseHoyoCodes(hoyo.hkrpg, "hkrpg").some((c) => c.code === "STARRAILGIFT"));
  assert.deepEqual(parseHoyoCodes(hoyo.nap, "nap").map((c) => c.code), ["ZENLESSGIFT", "ZZZINK32", "ZZZVOID32", "ZZZGRIND32"]);
});

test("parseHoyoCodes: status가 OK가 아니거나 다른 게임이면 뺀다", () => {
  const json = {
    codes: [
      { code: "GOODCODE1", status: "OK", game: "genshin" },
      { code: "BADCODE01", status: "NOT_OK", game: "genshin" },
      { code: "HSRCODE01", status: "OK", game: "hkrpg" },
    ],
  };
  assert.deepEqual(parseHoyoCodes(json, "genshin"), [{ code: "GOODCODE1", servers: null }]);
  assert.deepEqual(parseHoyoCodes(json, "hkrpg"), [{ code: "HSRCODE01", servers: null }]);
  assert.throws(() => parseHoyoCodes({ data: [] }, "genshin"), /codes 배열/);
});

test("parseWikiCodes 원신: Active Codes 표만, 중국 전용 제외", () => {
  const codes = parseWikiCodes(wiki.genshin, "Active_Codes", FIXTURE_DAY);
  assert.deepEqual(codes.map((c) => c.code), [
    "OPERACOLLAB", "EPIC2026", "VESNAONPATROL",
    "GS71XAVWDS", "GS71XDYGEO", "GS71XYNSYJ", "GS71XOXYLG",
    "Y6JYMKV6JKSL", "YOAL3V36XHS7", "DUGODWKRHAKDNJ", "BALLETCOLLAB", "2BJ64QRZ7RT8",
  ]);
  assert.ok(!codes.some((c) => c.code === "YUANSHEN"));
  assert.deepEqual(codes[0].servers, ["asia", "america", "europe", "sar"]);
});

test("parseWikiCodes 스타레일: All Codes 표에서 Expired 행은 뺀다", () => {
  // 앞쪽 12행 중 9행이 Expired, 3행이 Valid until: Unknown
  assert.deepEqual(parseWikiCodes(wiki.hkrpg, "All_Codes", FIXTURE_DAY).map((c) => c.code), [
    "NSJR3B97ZZ5X", "STARRAILFATE2026", "BESTCOFFEEEVER",
  ]);
});

test("parseWikiCodes 젠존제: Server가 All이면 모든 서버", () => {
  const codes = parseWikiCodes(wiki.nap, "All_Codes", FIXTURE_DAY);
  assert.deepEqual(codes.map((c) => c.code), ["ZZZVOID32", "ZZZINK32", "ZZZGRIND32", "ZENLESSGIFT"]);
  assert.deepEqual(codes[0].servers, ["asia", "america", "europe", "sar"]);
});

test("parseWikiCodes: Valid until이 지나면 뺀다", () => {
  const before = parseWikiCodes(wiki.genshin, "Active_Codes", new Date("2026-10-22T23:00:00Z")).map((c) => c.code);
  const after = parseWikiCodes(wiki.genshin, "Active_Codes", new Date("2026-10-23T00:00:01Z")).map((c) => c.code);
  assert.ok(before.includes("VESNAONPATROL"));
  assert.ok(!after.includes("VESNAONPATROL"));
  assert.equal(after.length, before.length - 1);
});

test("parseWikiCodes: 섹션이나 표가 없으면 예외", () => {
  assert.throws(() => parseWikiCodes({}, "Active_Codes"), /parse\.text/);
  assert.throws(() => parseWikiCodes({ parse: { text: "<h2>Other</h2>" } }, "Active_Codes"), /Active_Codes 섹션이 없음/);
  const noTable = '<h2><span id="Active_Codes">A</span></h2><p>표 없음</p><h2>Mail</h2><table class="wikitable"></table>';
  assert.throws(() => parseWikiCodes({ parse: { text: noTable } }, "Active_Codes"), /표가 없음/);
});

test("parseWikiCodes: 열 순서가 바뀌어도 헤더로 찾는다", () => {
  const html = `<h2><span id="Active_Codes">Active Codes</span></h2>
    <table class="wikitable sortable"><tr><th>Server</th><th>Duration</th><th>Code</th></tr>
    <tr><td>Asia</td><td>Discovered: May 1, 2026</td><td><b><code>ASIAONLY01</code></b></td></tr></table>`;
  assert.deepEqual(parseWikiCodes({ parse: { text: html } }, "Active_Codes", FIXTURE_DAY), [{ code: "ASIAONLY01", servers: ["asia"] }]);
});

test("parseWikiCodes: 코드 사이에 태그나 폭 없는 문자가 끼어도 한 코드로 읽는다", () => {
  const html = `<h2><span id="Active_Codes">A</span></h2><table class="wikitable"><tr><th>Code</th><th>Server</th><th>Rewards</th><th>Duration</th></tr>
    <tr><td><code>GS71X<wbr>AVWDS</code></td><td>All</td><td></td><td>x</td></tr>
    <tr><td><code>Vesna&#8203;On<span>Patrol</span></code></td><td>All</td><td></td><td>x</td></tr></table>`;
  assert.deepEqual(parseWikiCodes({ parse: { text: html } }, "Active_Codes", FIXTURE_DAY).map((c) => c.code), ["GS71XAVWDS", "VESNAONPATROL"]);
});

test("serversFromText", () => {
  assert.deepEqual(serversFromText("America, Europe, Asia, TW/HK/Macao"), ["asia", "america", "europe", "sar"]);
  assert.deepEqual(serversFromText("All"), ["asia", "america", "europe", "sar"]);
  assert.deepEqual(serversFromText("China"), []);
  assert.deepEqual(serversFromText("Europe"), ["europe"]);
  assert.equal(serversFromText("???"), null);
});

test("parseValidUntil / isExpired", () => {
  assert.equal(parseValidUntil("Discovered: September 23, 2026 Valid until: October 22, 2026").toISOString(), "2026-10-22T23:59:59.000Z");
  assert.equal(parseValidUntil("Valid: (indefinite)"), null);
  assert.equal(isExpired("Discovered: May 1, 2025 Expired: Unknown", FIXTURE_DAY), true);
  assert.equal(isExpired("Discovered: May 1, 2025 Expired: May 2, 2025", FIXTURE_DAY), true);
  assert.equal(isExpired("Discovered: May 1, 2025 Valid until: Unknown", FIXTURE_DAY), false);
  assert.equal(isExpired("Valid until: September 30, 2026", FIXTURE_DAY), true);
});

test("mergeCodes: 대소문자가 달랐던 코드도 하나로", () => {
  const merged = mergeCodes([
    { source: "hoyoCodes", codes: parseHoyoCodes(hoyo.genshin, "genshin") },
    { source: "fandom", codes: parseWikiCodes(wiki.genshin, "Active_Codes", FIXTURE_DAY) },
  ]);
  const vesna = merged.filter((c) => c.code === "VESNAONPATROL");
  assert.equal(vesna.length, 1);
  assert.deepEqual(vesna[0].sources, ["hoyoCodes", "fandom"]);
  assert.equal(new Set(merged.map((c) => c.code)).size, merged.length);
  assert.equal(merged.find((c) => c.code === "NEEI8A8341OW").servers, null, "hoyo-codes에만 있는 코드는 서버 정보 없음");
});

function fakeFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (!route) throw new TypeError("Failed to fetch");
    return { ok: route.status === 200, status: route.status, json: async () => route.body };
  };
}

test("collectCodes: 한 출처가 실패해도 진행하고 실패를 남긴다", async () => {
  const result = await collectCodes("genshin", { hoyoCodes: true, fandom: true }, {
    fetchImpl: fakeFetch({ [hoyoCodesUrl("genshin")]: { status: 200, body: hoyo.genshin }, [wikiUrl("genshin")]: { status: 403 } }),
    now: FIXTURE_DAY,
  });
  assert.equal(result.codes.length, 12);
  assert.deepEqual(result.errors, [{ source: "fandom", message: "HTTP 403" }]);
  assert.deepEqual(result.counts, { hoyoCodes: 12 });
});

test("collectCodes: 꺼진 출처는 요청하지 않는다", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => wiki.nap };
  };
  const result = await collectCodes("nap", { hoyoCodes: false, fandom: true }, { fetchImpl, now: FIXTURE_DAY });
  assert.deepEqual(seen, [wikiUrl("nap")]);
  assert.equal(result.codes.length, 4);
});
