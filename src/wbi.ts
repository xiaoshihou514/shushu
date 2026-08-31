/**
 * WBI 签名（逐字移植原版 `wbi.rs`）。纯函数，可单测。
 *
 * 流程：imgKey + subKey 按 MIXIN_KEY_ENC_TAB 打乱取前 32 字节得到 mixinKey；
 * 参数加 `wts` 时间戳、按键名排序、URL 编码后拼接，MD5(query + mixinKey)
 * 得到 `w_rid`。
 */

import { createHash } from "node:crypto";

/** 打乱表（原版 `MIXIN_KEY_ENC_TAB`，64 元素）。 */
export const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** WBI keys：`/x/web-interface/nav` 的 `wbi_img.img_url/sub_url` 文件名（去扩展名）。 */
export interface WbiKeys {
  imgKey: string;
  subKey: string;
}

/** 对 imgKey + subKey 做字符顺序打乱，取前 32 字节得到 mixinKey。 */
export function getMixinKey(imgKey: string, subKey: string): string {
  const orig = Buffer.from(imgKey + subKey, "utf8");
  const chars: string[] = [];
  for (let i = 0; i < 32; i += 1) {
    const index = MIXIN_KEY_ENC_TAB[i]!;
    // 原版 `orig[i] as char`：字节值直接作为码点，非 UTF-8 解码
    chars.push(String.fromCharCode(orig[index]!));
  }
  return chars.join("");
}

/**
 * URL 编码（原版 `get_url_encoded`）：ASCII 字母数字与 `-_.~` 原样保留，
 * `!'()*` 直接丢弃，其余字符按 UTF-8 字节编码为 `%XX`（大写十六进制）。
 */
export function urlEncode(value: string): string {
  let out = "";
  for (const char of value) {
    if (/[A-Za-z0-9\-_.~]/.test(char)) {
      out += char;
      continue;
    }
    if ("!'()*".includes(char)) continue;
    for (const byte of Buffer.from(char, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function md5(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

/**
 * 对请求参数做 WBI 签名：返回追加了 `wts` 与 `w_rid` 的新参数表。
 * 入参按键名升序排序后拼 `k=v` 并以 `&` 连接，取 MD5(query + mixinKey)。
 *
 * @param params - 原始参数（调用方先填好业务参数，如 keyword/bvid）。
 * @param keys - WBI keys。
 * @param timestamp - Unix 秒；默认当前时间（测试可注入固定值）。
 */
export function wbiSign(
  params: Record<string, string>,
  keys: WbiKeys,
  timestamp: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const mixinKey = getMixinKey(keys.imgKey, keys.subKey);
  const signed: Record<string, string> = { ...params, wts: String(timestamp) };
  const entries = Object.entries(signed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = entries.map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`).join("&");
  const wRid = md5(query + mixinKey);
  return { ...signed, w_rid: wRid };
}
