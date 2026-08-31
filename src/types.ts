/**
 * B 站 API 响应类型（原版 Rust `types/` serde 结构的精简 TS 翻译）。
 *
 * 只声明工具需要的字段；B 站字段会变，解析时对未声明字段不做校验
 * （见 docs/agent/bilibili-tool.md §4.5）。
 */

/** B 站统一响应壳：`code === 0` 表示成功，`data` 为业务数据。 */
export interface BiliResp<T> {
  code: number;
  message: string;
  ttl?: number;
  data?: T;
}

/** 普通视频（`/x/web-interface/view` 的 data）。 */
export interface NormalInfo {
  bvid: string;
  aid: number;
  title: string;
  desc: string;
  pic: string;
  pubdate: number;
  ctime: number;
  duration: number;
  tname?: string;
  owner: { mid: number; name: string; face: string };
  stat: {
    view: number;
    danmaku: number;
    reply: number;
    favorite: number;
    coin: number;
    share: number;
    like: number;
  };
  pages: Array<{ cid: number; page: number; part: string; duration: number }>;
  subtitle: { allow_submit?: boolean; list: Array<SubtitleDetail> };
  ugc_season?: { id: number; title: string; cover: string; ep_count: number };
}

/** 字幕条目（view 的 subtitle.list 与 player/v2 的 subtitle.subtitles 同构）。 */
export interface SubtitleDetail {
  id: number;
  lan: string;
  lan_doc: string;
  subtitle_url: string;
  ai_type?: number;
}

/** 番剧信息（`/pgc/view/web/season` 的 data，取关键字段）。 */
export interface BangumiInfo {
  season_id: number;
  season_title: string;
  title?: string;
  cover: string;
  evaluate: string;
  ep_count?: number;
  episodes: Array<EpInBangumi>;
  section?: Array<{ id: number; title: string; episodes: Array<EpInBangumi> }>;
  up_info?: { mid: number; uname: string };
  rating?: { score: number; count: number };
}

/** 番剧单集。 */
export interface EpInBangumi {
  id: number;
  ep_id: number;
  cid: number;
  aid: number;
  bvid?: string;
  title: string;
  long_title?: string;
  cover: string;
  duration?: number;
  pub_time?: number;
}

/** 课程信息（`/pugv/view/web/season` 的 data）。 */
export interface CheeseInfo {
  season_id: number;
  title: string;
  cover: string;
  ep_count: number;
  episodes: Array<EpInCheese>;
  up_info?: { mid: number; uname: string };
}

/** 课程单集。 */
export interface EpInCheese {
  id: number;
  ep_id: number;
  aid: number;
  cid: number;
  title: string;
  cover?: string;
  duration?: number;
}

/** UP 投稿列表（`/x/space/wbi/arc/search` 的 data）。 */
export interface UserVideoInfo {
  list: { vlist: Array<EpInUserVideo> };
  page: { pn: number; ps: number; count: number };
}

/** UP 投稿单条。 */
export interface EpInUserVideo {
  bvid: string;
  aid: number;
  title: string;
  pic: string;
  description: string;
  author: string;
  mid: number;
  created: number;
  length: string;
  play: number;
}

/** `parseTarget` 解析出的目标，对应原版 Get*InfoParams 判别联合。 */
export type Target =
  | { kind: "video"; bvid?: string; aid?: number }
  | { kind: "bangumi"; epId?: number; seasonId?: number }
  | { kind: "cheese"; epId?: number; seasonId?: number }
  | { kind: "user"; mid: number; page?: number };

/** 解析后的视频信息（对应原版 SearchResult 判别联合，kind 为判别字段）。 */
export type ViewResult =
  | { kind: "video"; info: NormalInfo }
  | { kind: "bangumi"; ep: EpInBangumi | null; info: BangumiInfo }
  | { kind: "cheese"; ep: EpInCheese | null; info: CheeseInfo }
  | { kind: "user"; info: UserVideoInfo };

/** 关键词搜索结果（B 站搜索 API 的 data，按 search_type 分别解析）。 */
export interface SearchResults {
  type: string;
  page: number;
  total: number;
  results: Array<{
    kind: string;
    bvid?: string;
    aid?: number;
    epId?: number;
    seasonId?: number;
    mid?: number;
    title: string;
    author?: string;
    cover?: string;
    duration?: string;
    play?: number;
    danmaku?: number;
    description?: string;
  }>;
}

/** playurl 的 dash 结构（只保留音频相关字段）。 */
export interface Dash {
  audio?: Array<MediaInDash>;
  dolby?: { audio?: Array<MediaInDash> };
  flac?: { audio?: MediaInDash };
}

/** dash 单条媒体流。 */
export interface MediaInDash {
  id: number;
  base_url: string;
  backup_url?: string[];
  bandwidth: number;
  mime_type?: string;
  codecs?: string;
  size?: number;
}

/** 音频质量 id → 名称（原版 audio_quality.rs）。 */
export const AUDIO_QUALITY = {
  30216: "64K",
  30232: "132K",
  30280: "192K",
  30250: "Dolby",
  30251: "HiRes",
} as const;

/** 音频质量名称（用户可配置的取值）。 */
export type AudioQualityName = "64K" | "132K" | "192K" | "Dolby" | "HiRes";

/** 从 dash 中挑选音频流的结果。 */
export interface SelectedAudio {
  id: number;
  quality: string;
  url: string;
  bandwidth: number;
  /** 备用镜像（base_url 不可达时依次尝试）。 */
  backupUrls?: string[];
}

/** 字幕内容（`{subtitle_url}` 的 json body）。 */
export interface SubtitleBody {
  body: Array<{ from: number; to: number; content: string }>;
}
