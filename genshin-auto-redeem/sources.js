// 코드 출처 두 곳(hoyo-codes API, Fandom 위키)을 읽는다.
// 서비스 워커에는 DOMParser가 없어서 위키 HTML은 문자열로 파싱한다.
import { GAMES, SERVERS } from "./games.js";

const FETCH_TIMEOUT_MS = 20000;

// 공식 교환 페이지가 /^[0-9A-Za-z]{1,30}$/ 로 검사한다. 실제 코드는 4자 이상.
const CODE_RE = /^[A-Z0-9]{4,30}$/;

export function normalizeCode(raw) {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function hoyoCodesUrl(gameId) {
  return `https://hoyo-codes.seria.moe/codes?game=${GAMES[gameId].hoyoCodes}`;
}

// /wiki/ 페이지는 Cloudflare 챌린지(403)에 막혀서, 같은 문서를 렌더링해 주는 MediaWiki API를 쓴다.
export function wikiUrl(gameId) {
  const { host, page } = GAMES[gameId].wiki;
  return `https://${host}/api.php?action=parse&page=${page}&prop=text&format=json&formatversion=2`;
}

// ---------------------------------------------------------------- hoyo-codes

/** { codes: [{ code, status: "OK", game, rewards }] } */
export function parseHoyoCodes(json, gameId) {
  if (!Array.isArray(json?.codes)) throw new Error("응답에 codes 배열이 없음");
  const game = GAMES[gameId].hoyoCodes;
  return json.codes
    .filter((item) => item && (item.game ?? game) === game && (item.status ?? "OK") === "OK")
    .map((item) => normalizeCode(item.code))
    .filter(Boolean)
    .map((code) => ({ code, servers: null }));
}

// ---------------------------------------------------------------- Fandom 위키

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : match;
  });
}

function cellText(html) {
  const text = html
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, " ") // 각주 [1]
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/** <code> 안의 코드. <wbr> 같은 태그와 폭 없는 문자가 끼어 있어도 공백 없이 이어 붙인다. */
function codeText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "");
}

/**
 * Server 열 → 서버 종류 목록.
 * "All" → 전부, "America, Europe, Asia, TW/HK/Macao" → 4개, "China" → [], 모르는 표기 → null(거르지 않음)
 */
export function serversFromText(text) {
  if (/\b(all|global)\b/i.test(text)) return [...SERVERS];
  const servers = [];
  if (/asia/i.test(text)) servers.push("asia");
  if (/america/i.test(text)) servers.push("america");
  if (/europe/i.test(text)) servers.push("europe");
  if (/\b(tw|hk|macao|sar)\b/i.test(text)) servers.push("sar");
  if (servers.length) return servers;
  return /china/i.test(text) ? [] : null;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** "Valid until: October 22, 2026" → 그날 23:59:59 UTC. 위키 시간은 UTC 기준이다. */
export function parseValidUntil(text) {
  const m = /valid until:?\s*([a-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(text);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (month < 0) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[2]), 23, 59, 59));
}

/** Duration 열 기준으로 끝난 코드인지. "Expired: ..."는 날짜가 Unknown이어도 끝난 것으로 본다. */
export function isExpired(durationText, now) {
  if (/\bexpired\b/i.test(durationText)) return true;
  const validUntil = parseValidUntil(durationText);
  return validUntil !== null && validUntil < now;
}

/** 헤더 행에서 열 위치를 찾는다. 못 찾으면 지금 표 구조(Code | Server | Rewards | Duration). */
function columnIndexes(headerCells) {
  const names = headerCells.map((cell) => cellText(cell).toLowerCase());
  const find = (word, fallback) => {
    const i = names.findIndex((name) => name.startsWith(word));
    return i >= 0 ? i : fallback;
  };
  return { code: find("code", 0), server: find("server", 1), duration: find("duration", 3) };
}

function sectionTable(html, sectionId) {
  const anchor = html.indexOf(`id="${sectionId}"`);
  if (anchor < 0) throw new Error(`${sectionId} 섹션이 없음`);
  const headingEnd = html.indexOf("</h2>", anchor);
  const nextHeading = html.indexOf("<h2", headingEnd < 0 ? anchor : headingEnd);
  const section = html.slice(anchor, nextHeading < 0 ? undefined : nextHeading);

  const start = section.search(/<table\b[^>]*\bwikitable\b/);
  if (start < 0) throw new Error(`${sectionId} 섹션에 표가 없음`);
  const end = section.indexOf("</table>", start);
  return section.slice(start, end < 0 ? undefined : end);
}

/**
 * MediaWiki parse API 응답에서 지정한 섹션의 첫 표를 읽는다.
 * 중국 서버 전용 행과 끝난 행은 뺀다.
 * @returns {{code: string, servers: string[]|null}[]}
 */
export function parseWikiCodes(json, sectionId, now = new Date()) {
  const html = json?.parse?.text;
  if (typeof html !== "string") throw new Error("응답에 parse.text가 없음");

  const rows = sectionTable(html, sectionId).split(/<tr\b[^>]*>/i).slice(1);
  let columns = { code: 0, server: 1, duration: 3 };
  const codes = [];

  for (const row of rows) {
    if (!/<td\b/i.test(row)) {
      if (/<th\b/i.test(row)) columns = columnIndexes(row.split(/<th\b[^>]*>/i).slice(1));
      continue;
    }
    const cells = row.split(/<t[dh]\b[^>]*>/i).slice(1);
    const rowCodes = [...(cells[columns.code] ?? "").matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)]
      .map((m) => normalizeCode(codeText(m[1])))
      .filter(Boolean);
    if (!rowCodes.length) continue; // 코드 대신 이벤트 링크만 있는 행

    const servers = serversFromText(cellText(cells[columns.server] ?? ""));
    if (servers?.length === 0) continue;
    if (isExpired(cellText(cells[columns.duration] ?? ""), now)) continue;

    for (const code of rowCodes) codes.push({ code, servers });
  }
  return codes;
}

// ---------------------------------------------------------------- 수집

/**
 * 같은 코드를 하나로 합친다. 서버 정보는 있는 것끼리 합치고, 아무 출처도 주지 않으면 null.
 * @param {{source: string, codes: {code: string, servers: string[]|null}[]}[]} lists
 */
export function mergeCodes(lists) {
  const byCode = new Map();
  for (const { source, codes } of lists) {
    for (const { code, servers } of codes) {
      const entry = byCode.get(code) ?? { code, sources: [], servers: null };
      byCode.set(code, entry);
      if (!entry.sources.includes(source)) entry.sources.push(source);
      if (servers) entry.servers = [...new Set([...(entry.servers ?? []), ...servers])];
    }
  }
  return [...byCode.values()];
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const SOURCES = {
  hoyoCodes: {
    name: "hoyo-codes",
    fetch: async (gameId, fetchImpl) => parseHoyoCodes(await fetchJson(hoyoCodesUrl(gameId), fetchImpl), gameId),
  },
  fandom: {
    name: "Fandom 위키",
    fetch: async (gameId, fetchImpl, now) =>
      parseWikiCodes(await fetchJson(wikiUrl(gameId), fetchImpl), GAMES[gameId].wiki.section, now),
  },
};

/**
 * 한 게임의 코드를 켜진 출처마다 한 번씩 받아 온다. 한 곳이 실패해도 나머지 결과는 쓴다.
 * @param {Record<string, boolean>} enabled  예: { hoyoCodes: true, fandom: true }
 */
export async function collectCodes(gameId, enabled, { fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const keys = Object.keys(SOURCES).filter((key) => enabled[key]);
  const results = await Promise.allSettled(keys.map((key) => SOURCES[key].fetch(gameId, fetchImpl, now)));

  const lists = [];
  const errors = [];
  const counts = {};
  results.forEach((result, i) => {
    const source = keys[i];
    if (result.status === "fulfilled") {
      lists.push({ source, codes: result.value });
      counts[source] = result.value.length;
    } else {
      errors.push({ source, message: result.reason?.message ?? String(result.reason) });
    }
  });
  return { codes: mergeCodes(lists), errors, counts };
}
