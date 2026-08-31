/**
 * 播放器信息（字幕列表 + 标签）：`/x/player/wbi/v2`（需 WBI 签名）。
 */

import type { BiliHttp } from "../http.ts";
import type { SubtitleBody, SubtitleDetail } from "../types.ts";
import type { WbiKeys } from "../wbi.ts";
import { wbiSign } from "../wbi.ts";

interface PlayerSubtitleData {
  subtitle?: { subtitles?: Array<SubtitleDetail> };
}

/**
 * 获取指定分 P（cid）的 CC 字幕列表。
 *
 * @param http - API 客户端。
 * @param getWbiKeys - 提供 WBI keys；拿不到时允许不带签名。
 * @param bvid - 视频 bvid。
 * @param cid - 分 P 的 cid。
 */
export async function fetchSubtitleList(
  http: BiliHttp,
  getWbiKeys: () => Promise<WbiKeys | undefined>,
  bvid: string,
  cid: number,
): Promise<SubtitleDetail[]> {
  const params: Record<string, string> = { bvid, cid: String(cid) };
  const keys = await getWbiKeys();
  const signed = keys === undefined ? params : wbiSign(params, keys);
  const data = await http.getJson<PlayerSubtitleData>("/x/player/wbi/v2", signed);
  return data.subtitle?.subtitles ?? [];
}

/** 拉取字幕内容（`{subtitle_url}` 的 json body）。 */
export async function fetchSubtitleContent(http: BiliHttp, subtitleUrl: string): Promise<SubtitleBody> {
  return (await http.getJson<SubtitleBody>(subtitleUrl)) as SubtitleBody;
}

/** 视频标签：`/x/web-interface/view/detail/tag`。 */
export async function fetchTags(http: BiliHttp, bvid: string, cid: number): Promise<string[]> {
  const data = await http.getJson<Array<{ tag_name?: string }>>("/x/web-interface/view/detail/tag", {
    bvid,
    cid: String(cid),
  });
  return data.map((tag) => tag.tag_name ?? "").filter((name) => name !== "");
}
