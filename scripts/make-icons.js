// 확장 프로그램 아이콘(PNG)을 외부 라이브러리 없이 생성한다: npm run icons
// 남색 둥근 사각형 위에 세 게임 색이 섞인 네 갈래 별.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZES = [16, 32, 48, 128];
const SS = 4; // 안티앨리어싱용 슈퍼샘플링

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// 팔마다 게임 색을 주고 가운데에서 섞이며 밝아지는 네 갈래 별. 공식 로고는 쓰지 않는다.
//   위 금색(원신 원석), 오른쪽 보라(스타레일 성옥), 아래 연두(젠존제), 왼쪽은 금색과 연두 사이
const BG_TOP = hex("#25325c");
const BG_BOTTOM = hex("#0f1529");
const GOLD = hex("#f6c86a");
const JADE = hex("#9d8cff");
const LIME = hex("#c9ee48");
const ARM_COLORS = [[0, GOLD], [90, JADE], [180, LIME], [270, mix(GOLD, LIME, 0.5)], [360, GOLD]];

// [가로 중심, 세로 중심, 가로 반지름, 세로 반지름]. 작은 아이콘은 키워서 뭉개지지 않게 한다.
const STAR = { normal: [0.5, 0.53, 0.33, 0.42], small: [0.5, 0.52, 0.4, 0.47] };
const SPARKLE = [0.8, 0.2, 0.07, 0.09];

const starValue = (x, y, cx, cy, a, b, p = 0.55) => Math.abs((x - cx) / a) ** p + Math.abs((y - cy) / b) ** p;

function armColor(x, y, cx, cy) {
  const deg = ((Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI + 360) % 360; // 위 0도, 시계 방향
  const i = ARM_COLORS.findIndex(([d]) => d > deg);
  const [d0, c0] = ARM_COLORS[i - 1];
  const [d1, c1] = ARM_COLORS[i];
  const t = (deg - d0) / (d1 - d0);
  return mix(c0, c1, t * t * (3 - 2 * t)); // 팔 끝은 또렷하게, 사이만 부드럽게
}

function shade(x, y, size) {
  if (!inRoundRect(x, y, 0.22)) return null;
  const small = size <= 16;
  const [cx, cy, a, b] = STAR[small ? "small" : "normal"];
  const v = starValue(x, y, cx, cy, a, b);
  if (v <= 1) return mix(armColor(x, y, cx, cy), [255, 255, 255], Math.max(0, 0.75 - v) * 0.9); // 가운데 빛
  if (!small && starValue(x, y, ...SPARKLE) <= 1) return [255, 255, 255];
  return mix(BG_TOP, BG_BOTTOM, y);
}

for (const size of SIZES) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, alpha = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          alpha++;
        }
      }
      const i = (py * size + px) * 4;
      if (alpha) {
        rgba[i] = Math.round(r / alpha);
        rgba[i + 1] = Math.round(g / alpha);
        rgba[i + 2] = Math.round(b / alpha);
      }
      rgba[i + 3] = Math.round((alpha / (SS * SS)) * 255);
    }
  }
  const out = new URL(`../hoyo-auto-redeem/icons/icon${size}.png`, import.meta.url);
  writeFileSync(out, encodePng(size, rgba));
  console.log(`icons/icon${size}.png`);
}
