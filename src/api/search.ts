/**
 * 关键词搜索（**新增能力**，原版无）：`/x/web-interface/wbi/search/type`。
 * 需要 WBI 签名。
 */

import type { BiliHttp } from "../http.ts";
import type { SearchResults } from "../types.ts";
import type { WbiKeys } from "../wbi.ts";
import { wbiSign } from "../wbi.ts";

/** 工具暴露的搜索类型 → B 站 search_type 参数。 */
export const SEARCH_TYPE_TO_PARAM: Record<string, string> = {
  video: "video",
  bangumi: "media_bangumi",
  cheese: "pgc",
  user: "bili_user",
  live_user: "live_user",
};

/** 去掉 B 站搜索结果标题里的 `<em class="keyword">` 高亮标签。 */
export function stripHighlightTags(title: string): string {
  return title.replace(/<[^>]+>/g, "");
}

/** 搜索单个条目（结构随 search_type 而变，统一抽取关键字段）。 */
function projectItem(type: string, item: Record<string, unknown>): SearchResults["results"][number] {
  const numberField = (key: string): number | undefined => {
    const value = item[key];
    return typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : undefined;
  };
  const bvid = typeof item.bvid === "string" ? item.bvid : undefined;
  const aid = numberField("aid");
  const epId = numberField("ep_id");
  const seasonId = numberField("season_id") ?? numberField("media_id");
  const mid = numberField("mid");
  const author =
    typeof item.author === "string" ? item.author : typeof item.uname === "string" ? item.uname : undefined;
  const cover =
    typeof item.pic === "string" ? item.pic : typeof item.cover === "string" ? item.cover : undefined;
  const description =
    typeof item.description === "string"
      ? item.description
      : typeof item.usign === "string"
        ? item.usign
        : undefined;
  const duration = typeof item.duration === "string" ? item.duration : undefined;
  const play = numberField("play");
  const danmaku = numberField("video_review");
  return {
    kind: type,
    title: stripHighlightTags(String(item.title ?? item.uname ?? "")),
    ...(bvid !== undefined ? { bvid } : {}),
    ...(aid !== undefined ? { aid } : {}),
    ...(epId !== undefined ? { epId } : {}),
    ...(seasonId !== undefined ? { seasonId } : {}),
    ...(mid !== undefined ? { mid } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(cover !== undefined ? { cover } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(play !== undefined ? { play } : {}),
    ...(danmaku !== undefined ? { danmaku } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/** 从 search/type 响应中抽取结果数组（`result` 可能是数组或按类型分组的对象）。 */
function extractResults(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const result = data.result;
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (typeof result === "object" && result !== null) {
    for (const value of Object.values(result)) {
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/**
 * 关键词搜索。
 *
 * @param http - API 客户端。
 * @param getWbiKeys - 提供 WBI keys；拿不到时允许不带签名（部分场景可能被风控）。
 * @param query - 关键词。
 * @param type - 搜索类型（video / bangumi / cheese / user / live_user）。
 * @param page - 页码，从 1 开始。
 */
export async function searchBilibili(
  http: BiliHttp,
  getWbiKeys: () => Promise<WbiKeys | undefined>,
  query: string,
  type: string,
  page: number,
): Promise<SearchResults> {
  const searchType = SEARCH_TYPE_TO_PARAM[type] ?? "video";
  const params: Record<string, string> = {
    search_type: searchType,
    keyword: query,
    page: String(page),
  };
  const keys = await getWbiKeys();
  const signed = keys === undefined ? params : wbiSign(params, keys);
  const data = await http.getJson<Record<string, unknown>>("/x/web-interface/wbi/search/type", signed);
  const total = typeof data.numResults === "number" ? data.numResults : 0;
  const results = extractResults(data).map((item) => projectItem(searchType, item));
  return { type: searchType, page, total, results };
}
