/**
 * URL/ID 解析与信息获取（对应原版 `commands.rs::search` 与 `bili_client.rs`
 * get_*_info 的移植）。输入可以是 bvid / av 号 / ep / ss / uid / 完整 URL。
 */

import type { BiliHttp } from "../http.ts";
import type {
  BangumiInfo,
  CheeseInfo,
  EpInBangumi,
  EpInCheese,
  NormalInfo,
  Target,
  UserVideoInfo,
  ViewResult,
} from "../types.ts";
import type { WbiKeys } from "../wbi.ts";
import { wbiSign } from "../wbi.ts";

/** 从 URL 路径段中提取 `av` / `bv` / `ep` / `ss` 号（移植前端 utils.tsx）。 */
function extractPrefixed(input: string, prefix: "av" | "bv" | "ep" | "ss"): string | number | undefined {
  let pathname = input;
  try {
    pathname = new URL(input).pathname;
  } catch {
    // 非 URL：直接按字符串处理
  }
  for (const segment of pathname.split("/")) {
    if (segment.toLowerCase().startsWith(prefix)) {
      const rest = segment.slice(prefix.length);
      if (prefix === "bv") return segment;
      const value = Number.parseInt(rest, 10);
      if (!Number.isNaN(value)) return value;
    }
  }
  return undefined;
}

/** 从 `space.bilibili.com/{uid}` 提取 uid。 */
function extractUid(input: string): number | undefined {
  try {
    const parsed = new URL(input);
    if (parsed.hostname !== "space.bilibili.com") return undefined;
    const uid = Number.parseInt(parsed.pathname.split("/")[1] ?? "", 10);
    return Number.isNaN(uid) ? undefined : uid;
  } catch {
    return undefined;
  }
}

/**
 * 把用户输入解析为 {@link Target}。支持：
 * - `BV1xx...` / `av123` / `ep123` / `ss123` / `uid123`（大小写不敏感）
 * - B 站视频 / 番剧 / 空间 URL（`bilibili.com/video/BV...`、`bangumi.bilibili.com/ep...`、
 *   `space.bilibili.com/123` 等）
 *
 * @throws 无法识别时抛 Error。
 */
export function parseTarget(input: string): Target {
  const raw = input.trim();
  const lower = raw.toLowerCase();

  if (lower.startsWith("bv")) return { kind: "video", bvid: raw };
  if (lower.startsWith("av")) {
    const aid = Number.parseInt(raw.slice(2), 10);
    if (!Number.isNaN(aid)) return { kind: "video", aid };
  }
  if (lower.startsWith("ep")) {
    const epId = Number.parseInt(raw.slice(2), 10);
    if (!Number.isNaN(epId)) return { kind: "bangumi", epId };
  }
  if (lower.startsWith("ss")) {
    const seasonId = Number.parseInt(raw.slice(2), 10);
    if (!Number.isNaN(seasonId)) return { kind: "bangumi", seasonId };
  }
  if (lower.startsWith("uid")) {
    const mid = Number.parseInt(raw.slice(3), 10);
    if (!Number.isNaN(mid)) return { kind: "user", mid };
  }

  const bvid = extractPrefixed(raw, "bv");
  if (typeof bvid === "string") return { kind: "video", bvid };

  const aid = extractPrefixed(raw, "av");
  if (typeof aid === "number") return { kind: "video", aid };

  const epId = extractPrefixed(raw, "ep");
  if (typeof epId === "number") return { kind: "bangumi", epId };

  const seasonId = extractPrefixed(raw, "ss");
  if (typeof seasonId === "number") return { kind: "bangumi", seasonId };

  const uid = extractUid(raw);
  if (uid !== undefined) return { kind: "user", mid: uid };

  throw new Error(`无法识别的 B 站目标: ${input}`);
}

/**
 * 按 {@link Target} 解析完整信息。普通视频 / 番剧 / 课程走对应 view 接口；
 * UP 空间走 `/x/space/wbi/arc/search`（需 WBI 签名）。
 *
 * @param http - API 客户端。
 * @param getWbiKeys - 提供 WBI keys 的回调（仅 user 目标需要；拿不到时允许不带签名）。
 * @param target - 解析后的目标。
 */
export async function resolveView(
  http: BiliHttp,
  getWbiKeys: () => Promise<WbiKeys | undefined>,
  target: Target,
): Promise<ViewResult> {
  switch (target.kind) {
    case "video": {
      const params: Record<string, string> = {};
      if (target.bvid !== undefined) params.bvid = target.bvid;
      if (target.aid !== undefined) params.aid = String(target.aid);
      const info = await http.getJson<NormalInfo>("/x/web-interface/view", params);
      return { kind: "video", info };
    }
    case "bangumi": {
      const params: Record<string, string> = {};
      if (target.epId !== undefined) params.ep_id = String(target.epId);
      if (target.seasonId !== undefined) params.season_id = String(target.seasonId);
      const info = await http.getJson<BangumiInfo>("/pgc/view/web/season", params);
      // 对齐原版：正片 + 各 section 分集里按 id 找目标集
      const allEpisodes: EpInBangumi[] = [
        ...info.episodes,
        ...(info.section ?? []).flatMap((section) => section.episodes),
      ];
      const ep =
        target.epId === undefined
          ? null
          : (allEpisodes.find((item: EpInBangumi) => item.id === target.epId) ?? null);
      return { kind: "bangumi", ep, info };
    }
    case "cheese": {
      const params: Record<string, string> = {};
      if (target.epId !== undefined) params.ep_id = String(target.epId);
      if (target.seasonId !== undefined) params.season_id = String(target.seasonId);
      const info = await http.getJson<CheeseInfo>("/pugv/view/web/season", params);
      const ep =
        target.epId === undefined
          ? null
          : (info.episodes.find((item: EpInCheese) => item.id === target.epId) ?? null);
      return { kind: "cheese", ep, info };
    }
    case "user": {
      const keys = await getWbiKeys();
      const params: Record<string, string> = {
        mid: String(target.mid),
        pn: String(target.page ?? 1),
        ps: "30",
      };
      const signed = keys === undefined ? params : wbiSign(params, keys);
      const info = await http.getJson<UserVideoInfo>("/x/space/wbi/arc/search", signed);
      return { kind: "user", info };
    }
  }
}
