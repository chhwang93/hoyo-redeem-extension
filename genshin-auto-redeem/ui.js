// 팝업과 옵션 페이지가 같이 쓰는 표시 도우미
import { STATUS } from "./redeem.js";
import { GAME_IDS } from "./games.js";

const BADGE_TONE = {
  success: "ok",
  new: "info",
  verify_required: "warn",
  login_required: "bad",
  account_error: "bad",
  server_error: "warn",
  cooldown: "warn",
  network_error: "warn",
  not_active: "warn",
  unknown: "warn",
};

export function statusBadge(status) {
  return el("span", { className: `badge ${BADGE_TONE[status] ?? ""}` }, STATUS[status]?.label ?? status);
}

/** 기록 한 줄의 설명. 응답 코드 숫자는 알 수 없는 응답일 때만 보여 준다. */
export function entryMessage(entry) {
  const message = entry.message === "OK" ? "" : entry.message ?? "";
  const unknown = entry.status === "unknown" || (entry.status === "gave_up" && entry.retcode != null);
  return unknown ? `${message} (응답 코드 ${entry.retcode})`.trim() : message;
}

/** 게임별 기록을 [{ game, code, entry }]로 펼쳐 최근 순으로 정렬한다. */
export function recentCodes(codes) {
  const time = (entry) => entry.triedAt || entry.firstSeenAt || "";
  return GAME_IDS.flatMap((game) => Object.entries(codes[game] ?? {}).map(([code, entry]) => ({ game, code, entry })))
    .sort((a, b) => time(b.entry).localeCompare(time(a.entry)));
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.map((child) => child ?? ""));
  return node;
}

const NO_RESPONSE = "확장이 응답하지 않아요. chrome://extensions에서 이 확장을 새로고침해 주세요.";

/**
 * 백그라운드에 요청을 보낸다. 실패해도 예외 대신 { error }를 돌려준다.
 * 확장을 새로고침하지 않아 백그라운드가 옛 버전이면 응답이 비어 온다.
 */
export async function send(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, ...payload })) ?? { error: NO_RESPONSE };
  } catch (e) {
    return { error: `${NO_RESPONSE} (${e?.message ?? e})` };
  }
}
