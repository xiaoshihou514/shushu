/**
 * BiliClient 门面：组合低层 http 与各 api 模块，缓存 WBI keys。
 * 对应原版 `BiliClient`（bili_client.rs）的角色。
 */

import { BiliHttp, type BiliHttpOptions } from "../http.ts";
import type {
  AudioQualityName,
  SearchResults,
  SelectedAudio,
  SubtitleBody,
  SubtitleDetail,
  Target,
  ViewResult,
} from "../types.ts";
import type { WbiKeys } from "../wbi.ts";
import { fetchNav, wbiKeysFromNav } from "./nav.ts";
import { fetchAudioStream, listAudioFormats, selectAudio } from "./playurl.ts";
import { fetchSubtitleContent, fetchSubtitleList, fetchTags } from "./player.ts";
import { searchBilibili } from "./search.ts";
import { parseTarget, resolveView } from "./view.ts";

/** WBI keys 缓存时长（ms），nav 的 keys 稳定，10 分钟够用。 */
const WBI_KEYS_TTL_MS = 10 * 60 * 1000;

/** BiliClient 构造参数（透传 {@link BiliHttpOptions}）。 */
export interface BiliClientOptions extends BiliHttpOptions {}

/** 面向工具层的 B 站客户端。 */
export class BiliClient {
  readonly http: BiliHttp;
  #keys: WbiKeys | undefined;
  #keysAt = 0;

  constructor(options: BiliClientOptions = {}) {
    this.http = new BiliHttp(options);
  }

  /**
   * 提供（缓存的）WBI keys；拿不到时返回 undefined，调用方降级为不带签名请求。
   * 首次获取失败不缓存，下次调用重试。
   */
  getWbiKeys = async (): Promise<WbiKeys | undefined> => {
    const now = Date.now();
    if (this.#keys !== undefined && now - this.#keysAt < WBI_KEYS_TTL_MS) {
      return this.#keys;
    }
    try {
      const nav = await fetchNav(this.http);
      const keys = wbiKeysFromNav(nav);
      if (keys !== undefined) {
        this.#keys = keys;
        this.#keysAt = now;
      } else {
        this.#keys = undefined;
      }
      return keys;
    } catch {
      this.#keys = undefined;
      return undefined;
    }
  };

  /** 登录态（含 uname/mid）。 */
  async nav(): Promise<{ isLogin: boolean; mid?: number; uname?: string }> {
    const nav = await fetchNav(this.http);
    return {
      isLogin: nav.isLogin,
      ...(nav.mid !== undefined ? { mid: nav.mid } : {}),
      ...(nav.uname !== undefined ? { uname: nav.uname } : {}),
    };
  }

  /** 解析用户输入并拉取完整信息。 */
  async view(input: string): Promise<ViewResult> {
    return resolveView(this.http, this.getWbiKeys, parseTarget(input));
  }

  /** 解析用户输入（不请求网络）。 */
  parseTarget(input: string): Target {
    return parseTarget(input);
  }

  /** 关键词搜索。 */
  search(query: string, type: string, page: number): Promise<SearchResults> {
    return searchBilibili(this.http, this.getWbiKeys, query, type, page);
  }

  /** 指定分 P 的 CC 字幕列表。 */
  subtitleList(bvid: string, cid: number): Promise<SubtitleDetail[]> {
    return fetchSubtitleList(this.http, this.getWbiKeys, bvid, cid);
  }

  /** 字幕内容（绝对 URL）。 */
  subtitleContent(url: string): Promise<SubtitleBody> {
    return fetchSubtitleContent(this.http, url);
  }

  /** 视频标签。 */
  tags(bvid: string, cid: number): Promise<string[]> {
    return fetchTags(this.http, bvid, cid);
  }

  /** 音频流（dash 中按目标质量选择）。 */
  audioStream(
    kind: "video" | "bangumi" | "cheese",
    ids: { bvid?: string; cid?: number; epId?: number },
    desired: AudioQualityName,
  ): Promise<SelectedAudio | null> {
    return fetchAudioStream(this.http, this.getWbiKeys, kind, ids, desired);
  }

  /** 可用音频档位列表（info 工具展示用）。 */
  audioFormats(
    kind: "video" | "bangumi" | "cheese",
    ids: { bvid?: string; cid?: number; epId?: number },
  ): Promise<Array<{ id: number; quality: string }>> {
    return listAudioFormats(this.http, this.getWbiKeys, kind, ids);
  }
}

export { parseTarget, resolveView, selectAudio };
