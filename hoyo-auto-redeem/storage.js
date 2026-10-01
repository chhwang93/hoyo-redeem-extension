// chrome.storage.local 구조
//   settings: { games: {genshin, hkrpg, nap}, accounts: {게임: {uid, region, source}}, lang, intervalMinutes,
//               sources: {hoyoCodes, fandom}, transport }
//   codes   : { 게임: { CODE: { status, message, retcode, triedAt, attempts, firstSeenAt, sources } } }
//   meta    : { lastCheckAt, lastRun, login, transport, roles: {게임: {...}}, deviceId, log }
import { GAME_IDS } from "./games.js";

const emptyAccount = () => ({ uid: "", region: "", source: "" });

export const DEFAULT_SETTINGS = {
  games: Object.fromEntries(GAME_IDS.map((id) => [id, true])),
  accounts: Object.fromEntries(GAME_IDS.map((id) => [id, emptyAccount()])),
  lang: "ko",
  intervalMinutes: 30,
  sources: { hoyoCodes: true, fandom: true },
  transport: "auto", // auto | fetch | tab
};

export const INTERVAL_MIN = 10;
export const INTERVAL_MAX = 1440;

/** 1.0(원신 전용)의 settings.uid / region / accountSource를 accounts.genshin으로 옮긴다. */
function migrateSettings(settings) {
  if (!settings || !("uid" in settings)) return settings;
  const { uid, region, accountSource, ...rest } = settings;
  return {
    ...rest,
    accounts: { ...rest.accounts, genshin: { uid: uid ?? "", region: region ?? "", source: accountSource ?? "" } },
  };
}

export function normalizeSettings(raw) {
  const settings = migrateSettings(raw) ?? {};
  const accounts = Object.fromEntries(GAME_IDS.map((id) => [id, { ...emptyAccount(), ...settings.accounts?.[id] }]));
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    games: { ...DEFAULT_SETTINGS.games, ...settings.games },
    accounts,
    sources: { ...DEFAULT_SETTINGS.sources, ...settings.sources },
  };
}

/** 1.0은 codes가 { CODE: entry }였다. 원신 기록으로 옮긴다. */
export function normalizeCodes(raw) {
  const codes = raw ?? {};
  const isLegacy = Object.values(codes).some((value) => typeof value?.status === "string");
  const byGame = isLegacy ? { genshin: codes } : codes;
  return Object.fromEntries(GAME_IDS.map((id) => [id, { ...byGame[id] }]));
}

/** 1.0의 meta.account(원신 캐릭터)를 roles.genshin으로 옮긴다. */
export function normalizeMeta(raw) {
  const { account, ...meta } = raw ?? {};
  const roles = { ...meta.roles };
  if (account && !roles.genshin) roles.genshin = account;
  return { ...meta, roles };
}

export function clampInterval(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return DEFAULT_SETTINGS.intervalMinutes;
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, minutes));
}

export async function loadAll() {
  const { settings, codes, meta } = await chrome.storage.local.get(["settings", "codes", "meta"]);
  return { settings: normalizeSettings(settings), codes: normalizeCodes(codes), meta: normalizeMeta(meta) };
}

/** settings는 지금 저장된 값에 덮어 쓰고(accounts는 게임별로), codes와 meta는 통째로 저장한다. */
export async function saveAll({ settings, codes, meta }) {
  const patch = {};
  if (settings) {
    const current = normalizeSettings((await chrome.storage.local.get("settings")).settings);
    patch.settings = normalizeSettings({
      ...current,
      ...settings,
      accounts: { ...current.accounts, ...settings.accounts },
    });
  }
  if (codes) patch.codes = codes;
  if (meta) patch.meta = meta;
  await chrome.storage.local.set(patch);
}

/** 좁은 표에 쓰는 짧은 시각. 오늘이면 "14:05", 다른 날이면 "10/1". */
export function formatShortTime(iso, now = new Date()) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  if (date.toDateString() !== now.toDateString()) return `${date.getMonth() + 1}/${date.getDate()}`;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
