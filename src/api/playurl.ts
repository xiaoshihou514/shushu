/**
 * playurl 音频流获取与选择：`/x/player/wbi/playurl`（普通）、
 * `/pgc/player/web/v2/playurl`（番剧）、`/pugv/player/web/playurl`（课程）。
 * 只消费 dash 的音频轨（audio / dolby / flac），不做视频。
 */

import type { BiliHttp } from "../http.ts";
import { AUDIO_QUALITY, type AudioQualityName, type Dash, type SelectedAudio } from "../types.ts";
import type { WbiKeys } from "../wbi.ts";
import { wbiSign } from "../wbi.ts";

/** playurl 请求常量：qn=127 与 fnval=4048 与移动端一致，返回全档位 dash。 */
const QN = "127";
const FNVAL = "4048";

/** 默认音频质量优先级（高 → 低）。 */
export const DEFAULT_AUDIO_PRIORITY: AudioQualityName[] = ["HiRes", "Dolby", "192K", "132K", "64K"];

interface PlayUrlData {
  dash?: Dash;
  timelength?: number;
}

/** 音频质量名 → 档位 id（原版 audio_quality.rs）。 */
function qualityId(quality: AudioQualityName): number {
  switch (quality) {
    case "64K":
      return 30216;
    case "132K":
      return 30232;
    case "192K":
      return 30280;
    case "Dolby":
      return 30250;
    case "HiRes":
      return 30251;
  }
}

/** 把 dash 里所有音频候选（audio/dolby/flac）收集为统一列表。 */
function collectAudioCandidates(dash: Dash): Array<{
  id: number;
  baseUrl: string;
  backupUrls: string[];
  bandwidth: number;
}> {
  const candidates: Array<{ id: number; baseUrl: string; backupUrls: string[]; bandwidth: number }> = [];
  for (const media of dash.audio ?? []) {
    candidates.push({
      id: media.id,
      baseUrl: media.base_url,
      backupUrls: media.backup_url ?? [],
      bandwidth: media.bandwidth,
    });
  }
  for (const media of dash.dolby?.audio ?? []) {
    candidates.push({
      id: media.id,
      baseUrl: media.base_url,
      backupUrls: media.backup_url ?? [],
      bandwidth: media.bandwidth,
    });
  }
  if (dash.flac?.audio !== undefined) {
    candidates.push({
      id: dash.flac.audio.id,
      baseUrl: dash.flac.audio.base_url,
      backupUrls: dash.flac.audio.backup_url ?? [],
      bandwidth: dash.flac.audio.bandwidth,
    });
  }
  return candidates;
}

/**
 * 按目标质量从 dash 中选择音频流：先精确匹配档位 id，否则按优先级
 * （`priority` 高 → 低，默认 {@link DEFAULT_AUDIO_PRIORITY}）取第一个可用档。
 * 全部不匹配时取第一个候选。
 *
 * @returns 选中的音频流，无任何候选时返回 null。
 */
export function selectAudio(
  dash: Dash,
  desired: AudioQualityName,
  priority: AudioQualityName[] = DEFAULT_AUDIO_PRIORITY,
): SelectedAudio | null {
  const candidates = collectAudioCandidates(dash);
  if (candidates.length === 0) return null;
  const desiredId = qualityId(desired);
  const exact = candidates.find((media) => media.id === desiredId);
  const picked = exact ?? pickByPriority(candidates, priority) ?? candidates[0]!;
  return {
    id: picked.id,
    quality: AUDIO_QUALITY[picked.id as keyof typeof AUDIO_QUALITY] ?? String(picked.id),
    url: picked.baseUrl,
    bandwidth: picked.bandwidth,
    ...(picked.backupUrls.length > 0 ? { backupUrls: picked.backupUrls } : {}),
  };
}

/** 按优先级顺序挑选候选（返回第一个出现在优先级列表里的候选）。 */
function pickByPriority(
  candidates: Array<{ id: number; baseUrl: string; backupUrls: string[]; bandwidth: number }>,
  priority: AudioQualityName[],
): { id: number; baseUrl: string; backupUrls: string[]; bandwidth: number } | undefined {
  for (const name of priority) {
    const id = qualityId(name);
    const found = candidates.find((media) => media.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 获取音频流。
 *
 * @param http - API 客户端。
 * @param getWbiKeys - 提供 WBI keys（普通视频需要；拿不到时允许不带签名）。
 * @param kind - 视频类型（video / bangumi / cheese）。
 * @param ids - 目标 id：`{ bvid, cid }`（video）或 `{ epId }`（bangumi/cheese）。
 * @param desired - 期望的音频质量。
 */
export async function fetchAudioStream(
  http: BiliHttp,
  getWbiKeys: () => Promise<WbiKeys | undefined>,
  kind: "video" | "bangumi" | "cheese",
  ids: { bvid?: string; cid?: number; epId?: number },
  desired: AudioQualityName,
): Promise<SelectedAudio | null> {
  const data = await fetchPlayUrlData(http, getWbiKeys, kind, ids);
  if (data.dash === undefined) {
    // 可能无版权/未登录/该视频无音频轨
    return null;
  }
  return selectAudio(data.dash, desired);
}

/** 可用音频档位（去重，按 dash 中出现顺序）。 */
export async function listAudioFormats(
  http: BiliHttp,
  getWbiKeys: () => Promise<WbiKeys | undefined>,
  kind: "video" | "bangumi" | "cheese",
  ids: { bvid?: string; cid?: number; epId?: number },
): Promise<Array<{ id: number; quality: string }>> {
  const data = await fetchPlayUrlData(http, getWbiKeys, kind, ids);
  const formats = new Map<number, string>();
  for (const media of data.dash?.audio ?? []) {
    formats.set(media.id, AUDIO_QUALITY[media.id as keyof typeof AUDIO_QUALITY] ?? String(media.id));
  }
  for (const media of data.dash?.dolby?.audio ?? []) {
    formats.set(media.id, AUDIO_QUALITY[media.id as keyof typeof AUDIO_QUALITY] ?? String(media.id));
  }
  if (data.dash?.flac?.audio !== undefined) {
    formats.set(
      data.dash.flac.audio.id,
      AUDIO_QUALITY[data.dash.flac.audio.id as keyof typeof AUDIO_QUALITY] ?? String(data.dash.flac.audio.id),
    );
  }
  return [...formats.entries()].map(([id, quality]) => ({ id, quality }));
}

/** 拉取 playurl 原始数据（audio/dolby/flac 三系共用）。 */
async function fetchPlayUrlData(
  http: BiliHttp,
  getWbiKeys: () => Promise<WbiKeys | undefined>,
  kind: "video" | "bangumi" | "cheese",
  ids: { bvid?: string; cid?: number; epId?: number },
): Promise<PlayUrlData> {
  const params: Record<string, string> = { qn: QN, fnval: FNVAL };
  let path: string;
  if (kind === "video") {
    if (ids.bvid === undefined || ids.cid === undefined) {
      throw new Error("视频音频流需要 bvid 与 cid");
    }
    path = "/x/player/wbi/playurl";
    params.bvid = ids.bvid;
    params.cid = String(ids.cid);
  } else if (kind === "bangumi") {
    if (ids.epId === undefined) throw new Error("番剧音频流需要 ep_id");
    path = "/pgc/player/web/v2/playurl";
    params.ep_id = String(ids.epId);
  } else {
    if (ids.epId === undefined) throw new Error("课程音频流需要 ep_id");
    path = "/pugv/player/web/playurl";
    params.ep_id = String(ids.epId);
  }

  const keys = await getWbiKeys();
  const signed = keys === undefined ? params : wbiSign(params, keys);
  return http.getJson<PlayUrlData>(path, signed);
}
