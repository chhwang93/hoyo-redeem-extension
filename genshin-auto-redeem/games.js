// 게임별 설정. 주소와 파라미터는 각 게임의 공식 교환 페이지 코드에서 확인 (2026-10-01).
// 원신은 GET, 스타레일·젠존제는 보안 검사가 붙은 POST(webExchangeCdkeyRisk)를 쓴다.

export const GAMES = {
  genshin: {
    name: "원신",
    short: "원신",
    gameBiz: "hk4e_global",
    hoyoCodes: "genshin",
    wiki: { host: "genshin-impact.fandom.com", page: "Promotional_Code", section: "Active_Codes" },
    redeemUrl: "https://public-operation-hk4e.hoyoverse.com/common/apicdkey/api/webExchangeCdkey",
    riskControl: false,
    giftPage: "https://genshin.hoyoverse.com/ko/gift",
    regions: { asia: "os_asia", america: "os_usa", europe: "os_euro", sar: "os_cht" },
    uidPrefixes: { 6: "america", 7: "europe", 8: "asia", 18: "asia", 9: "sar" },
  },
  hkrpg: {
    name: "붕괴: 스타레일",
    short: "스타레일",
    gameBiz: "hkrpg_global",
    hoyoCodes: "hkrpg",
    wiki: { host: "honkai-star-rail.fandom.com", page: "Redemption_Code", section: "All_Codes" },
    redeemUrl: "https://public-operation-hkrpg.hoyoverse.com/common/apicdkey/api/webExchangeCdkeyRisk",
    riskControl: true,
    giftPage: "https://hsr.hoyoverse.com/gift",
    regions: { asia: "prod_official_asia", america: "prod_official_usa", europe: "prod_official_eur", sar: "prod_official_cht" },
    uidPrefixes: { 6: "america", 7: "europe", 8: "asia", 9: "sar" },
  },
  nap: {
    name: "젠레스 존 제로",
    short: "젠존제",
    gameBiz: "nap_global",
    hoyoCodes: "nap",
    wiki: { host: "zenless-zone-zero.fandom.com", page: "Redemption_Code", section: "All_Codes" },
    redeemUrl: "https://public-operation-nap.hoyoverse.com/common/apicdkey/api/webExchangeCdkeyRisk",
    riskControl: true,
    giftPage: "https://zenless.hoyoverse.com/redemption",
    regions: { asia: "prod_gf_jp", america: "prod_gf_us", europe: "prod_gf_eu", sar: "prod_gf_sg" },
    uidPrefixes: { 10: "america", 15: "europe", 13: "asia", 17: "sar" },
  },
};

export const GAME_IDS = Object.keys(GAMES);

/** 서버 종류. 계정 조회는 이 순서로 시도한다. */
export const SERVERS = ["asia", "america", "europe", "sar"];

export const SERVER_NAMES = { asia: "아시아", america: "미국", europe: "유럽", sar: "TW/HK/MO" };

/** 게임 고유의 region 값 → 서버 종류 */
export function serverOf(gameId, region) {
  const regions = GAMES[gameId].regions;
  return SERVERS.find((server) => regions[server] === region) ?? null;
}

export function regionName(gameId, region) {
  return SERVER_NAMES[serverOf(gameId, region)] ?? region ?? "";
}

/** UID 앞자리(뒤 8자리를 뺀 부분)로 region을 추정한다. */
export function regionFromUid(gameId, uid) {
  const digits = String(uid ?? "").trim();
  if (!/^\d{9,10}$/.test(digits)) return null;
  const server = GAMES[gameId].uidPrefixes[digits.slice(0, -8)];
  return server ? GAMES[gameId].regions[server] : null;
}

export function giftPageUrl(gameId, code) {
  const page = GAMES[gameId].giftPage;
  return code ? `${page}?code=${encodeURIComponent(code)}` : page;
}
