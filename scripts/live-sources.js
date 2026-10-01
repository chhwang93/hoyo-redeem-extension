// 실제 출처에서 코드를 받아 확장과 같은 파서로 읽어 본다. 사이트 구조가 바뀌었는지 볼 때: npm run check:sources
import { collectCodes, SOURCES } from "../hoyo-auto-redeem/sources.js";
import { GAMES, GAME_IDS } from "../hoyo-auto-redeem/games.js";

let failed = false;
for (const gameId of GAME_IDS) {
  const { codes, errors, counts } = await collectCodes(gameId, { hoyoCodes: true, fandom: true });
  const countText = Object.entries(counts).map(([source, n]) => `${SOURCES[source].name} ${n}`).join(", ");
  console.log(`\n${GAMES[gameId].name}: ${codes.length}개 (${countText})`);
  for (const e of errors) console.log(`  실패: ${SOURCES[e.source].name} - ${e.message}`);
  for (const c of codes) console.log(`  ${c.code.padEnd(18)} ${c.sources.join("+").padEnd(18)} ${c.servers?.join(",") ?? ""}`);
  failed ||= errors.length > 0;
}
process.exitCode = failed ? 1 : 0;
