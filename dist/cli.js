#!/usr/bin/env node

// src/http.ts
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
var REFERRER = "https://www.bilibili.com/";
var DEFAULT_TIMEOUT_MS = 3e4;
var DEFAULT_RETRIES = 3;
var DEFAULT_REQUEST_INTERVAL_MS = 200;
var BACKOFF_BASE_MS = 300;
var BiliError = class extends Error {
  code;
  constructor(code, message) {
    super(`bilibili ${code}: ${message}`);
    this.name = "BiliError";
    this.code = code;
  }
};
function isTransientStatus(status) {
  return status >= 500 || status === 429;
}
var BiliHttp = class {
  sessdata;
  retries;
  requestIntervalMs;
  timeoutMs;
  #lastRequestAt = 0;
  constructor(options = {}) {
    this.sessdata = options.sessdata ?? "";
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
  /** 生成带基础头的请求头：UA、Referer、可选 SESSDATA cookie。 */
  headers() {
    const headers = {
      "user-agent": USER_AGENT,
      referer: REFERRER
    };
    if (this.sessdata !== "") headers.cookie = `SESSDATA=${this.sessdata}`;
    return headers;
  }
  /** 请求间隔限速：保证相邻请求至少间隔 `requestIntervalMs`。 */
  async pace() {
    const wait = this.#lastRequestAt + this.requestIntervalMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.#lastRequestAt = Date.now();
  }
  /**
   * 带重试的一次请求。瞬态错误（网络异常 / 5xx / 429）指数退避重试，
   * 4xx 与 BiliResp 业务错误不重试。
   *
   * @param url - 完整 URL。
   * @param init - fetch init（超时由内部 AbortSignal 兜底）。
   * @returns 最终响应。
   */
  async request(url, init = {}) {
    let attempt = 0;
    while (true) {
      await this.pace();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          headers: { ...this.headers(), ...init.headers },
          signal: init.signal ?? controller.signal
        });
        if (!isTransientStatus(response.status) || attempt >= this.retries) {
          return response;
        }
        await response.body?.cancel();
      } catch (error) {
        if (attempt >= this.retries) throw error;
      } finally {
        clearTimeout(timer);
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
    }
  }
  /**
   * GET 一个 B 站 API 端点，解析 `BiliResp` 并返回 `data`。
   * `path` 传完整 URL（`http(s)://...`）时原样使用，用于字幕等外部资源地址。
   *
   * @param path - 端点路径（如 `/x/web-interface/view`）或完整 URL。
   * @param params - 查询参数（可为空；WBI 签名由调用方预先附加）。
   * @returns `BiliResp.data`（调用方按端点类型断言）。
   */
  async getJson(path, params = {}) {
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(`https://api.bilibili.com${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== "") url.searchParams.set(key, value);
    }
    const response = await this.request(url.toString());
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new BiliError(response.status, `HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const body = await response.json();
    if (body.code !== 0) {
      throw new BiliError(body.code, body.message || "\u672A\u77E5\u9519\u8BEF");
    }
    if (body.data === void 0) {
      throw new BiliError(body.code, "\u54CD\u5E94\u7F3A\u5C11 data \u5B57\u6BB5");
    }
    return body.data;
  }
  /** GET 一个任意 URL 的文本内容（如字幕 json、弹幕 XML）。 */
  async getText(url) {
    const response = await this.request(url);
    if (!response.ok) {
      throw new BiliError(response.status, `HTTP ${response.status}`);
    }
    return response.text();
  }
  /** GET 一个任意 URL 的二进制内容（如音频流、封面）。 */
  async getArrayBuffer(url) {
    const response = await this.request(url);
    if (!response.ok) {
      throw new BiliError(response.status, `HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  }
};

// src/api/nav.ts
function takeFilename(url) {
  const afterSlash = url.split("/").pop();
  if (afterSlash === void 0) return void 0;
  const dotIndex = afterSlash.lastIndexOf(".");
  if (dotIndex <= 0) return void 0;
  return afterSlash.slice(0, dotIndex);
}
async function fetchNav(http) {
  const data = await http.getJson("/x/web-interface/nav");
  const wbiImg = data.wbi_img !== void 0 ? {
    imgUrl: data.wbi_img.img_url,
    subUrl: data.wbi_img.sub_url
  } : void 0;
  const nav = {
    isLogin: data.isLogin ?? false,
    ...data.mid !== void 0 ? { mid: data.mid } : {},
    ...data.uname !== void 0 ? { uname: data.uname } : {},
    ...wbiImg !== void 0 ? { wbiImg } : {}
  };
  return nav;
}
function wbiKeysFromNav(nav) {
  if (nav.wbiImg === void 0) return void 0;
  const imgKey = takeFilename(nav.wbiImg.imgUrl);
  const subKey = takeFilename(nav.wbiImg.subUrl);
  if (imgKey === void 0 || subKey === void 0) return void 0;
  return { imgKey, subKey };
}

// src/types.ts
var AUDIO_QUALITY = {
  30216: "64K",
  30232: "132K",
  30280: "192K",
  30250: "Dolby",
  30251: "HiRes"
};

// src/wbi.ts
import { createHash } from "crypto";
var MIXIN_KEY_ENC_TAB = [
  46,
  47,
  18,
  2,
  53,
  8,
  23,
  32,
  15,
  50,
  10,
  31,
  58,
  3,
  45,
  35,
  27,
  43,
  5,
  49,
  33,
  9,
  42,
  19,
  29,
  28,
  14,
  39,
  12,
  38,
  41,
  13,
  37,
  48,
  7,
  16,
  24,
  55,
  40,
  61,
  26,
  17,
  0,
  1,
  60,
  51,
  30,
  4,
  22,
  25,
  54,
  21,
  56,
  59,
  6,
  63,
  57,
  62,
  11,
  36,
  20,
  34,
  44,
  52
];
function getMixinKey(imgKey, subKey) {
  const orig = Buffer.from(imgKey + subKey, "utf8");
  const chars = [];
  for (let i = 0; i < 32; i += 1) {
    const index = MIXIN_KEY_ENC_TAB[i];
    chars.push(String.fromCharCode(orig[index]));
  }
  return chars.join("");
}
function urlEncode(value) {
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
function md5(value) {
  return createHash("md5").update(value, "utf8").digest("hex");
}
function wbiSign(params, keys, timestamp = Math.floor(Date.now() / 1e3)) {
  const mixinKey = getMixinKey(keys.imgKey, keys.subKey);
  const signed = { ...params, wts: String(timestamp) };
  const entries = Object.entries(signed).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const query = entries.map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`).join("&");
  const wRid = md5(query + mixinKey);
  return { ...signed, w_rid: wRid };
}

// src/api/playurl.ts
var QN = "127";
var FNVAL = "4048";
var DEFAULT_AUDIO_PRIORITY = ["HiRes", "Dolby", "192K", "132K", "64K"];
function qualityId(quality) {
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
function collectAudioCandidates(dash) {
  const candidates = [];
  for (const media of dash.audio ?? []) {
    candidates.push({
      id: media.id,
      baseUrl: media.base_url,
      backupUrls: media.backup_url ?? [],
      bandwidth: media.bandwidth
    });
  }
  for (const media of dash.dolby?.audio ?? []) {
    candidates.push({
      id: media.id,
      baseUrl: media.base_url,
      backupUrls: media.backup_url ?? [],
      bandwidth: media.bandwidth
    });
  }
  if (dash.flac?.audio !== void 0) {
    candidates.push({
      id: dash.flac.audio.id,
      baseUrl: dash.flac.audio.base_url,
      backupUrls: dash.flac.audio.backup_url ?? [],
      bandwidth: dash.flac.audio.bandwidth
    });
  }
  return candidates;
}
function selectAudio(dash, desired, priority = DEFAULT_AUDIO_PRIORITY) {
  const candidates = collectAudioCandidates(dash);
  if (candidates.length === 0) return null;
  const desiredId = qualityId(desired);
  const exact = candidates.find((media) => media.id === desiredId);
  const picked = exact ?? pickByPriority(candidates, priority) ?? candidates[0];
  return {
    id: picked.id,
    quality: AUDIO_QUALITY[picked.id] ?? String(picked.id),
    url: picked.baseUrl,
    bandwidth: picked.bandwidth,
    ...picked.backupUrls.length > 0 ? { backupUrls: picked.backupUrls } : {}
  };
}
function pickByPriority(candidates, priority) {
  for (const name of priority) {
    const id = qualityId(name);
    const found = candidates.find((media) => media.id === id);
    if (found !== void 0) return found;
  }
  return void 0;
}
async function fetchAudioStream(http, getWbiKeys, kind, ids, desired) {
  const data = await fetchPlayUrlData(http, getWbiKeys, kind, ids);
  if (data.dash === void 0) {
    return null;
  }
  return selectAudio(data.dash, desired);
}
async function listAudioFormats(http, getWbiKeys, kind, ids) {
  const data = await fetchPlayUrlData(http, getWbiKeys, kind, ids);
  const formats = /* @__PURE__ */ new Map();
  for (const media of data.dash?.audio ?? []) {
    formats.set(media.id, AUDIO_QUALITY[media.id] ?? String(media.id));
  }
  for (const media of data.dash?.dolby?.audio ?? []) {
    formats.set(media.id, AUDIO_QUALITY[media.id] ?? String(media.id));
  }
  if (data.dash?.flac?.audio !== void 0) {
    formats.set(
      data.dash.flac.audio.id,
      AUDIO_QUALITY[data.dash.flac.audio.id] ?? String(data.dash.flac.audio.id)
    );
  }
  return [...formats.entries()].map(([id, quality]) => ({ id, quality }));
}
async function fetchPlayUrlData(http, getWbiKeys, kind, ids) {
  const params = { qn: QN, fnval: FNVAL };
  let path;
  if (kind === "video") {
    if (ids.bvid === void 0 || ids.cid === void 0) {
      throw new Error("\u89C6\u9891\u97F3\u9891\u6D41\u9700\u8981 bvid \u4E0E cid");
    }
    path = "/x/player/wbi/playurl";
    params.bvid = ids.bvid;
    params.cid = String(ids.cid);
  } else if (kind === "bangumi") {
    if (ids.epId === void 0) throw new Error("\u756A\u5267\u97F3\u9891\u6D41\u9700\u8981 ep_id");
    path = "/pgc/player/web/v2/playurl";
    params.ep_id = String(ids.epId);
  } else {
    if (ids.epId === void 0) throw new Error("\u8BFE\u7A0B\u97F3\u9891\u6D41\u9700\u8981 ep_id");
    path = "/pugv/player/web/playurl";
    params.ep_id = String(ids.epId);
  }
  const keys = await getWbiKeys();
  const signed = keys === void 0 ? params : wbiSign(params, keys);
  return http.getJson(path, signed);
}

// src/api/player.ts
async function fetchSubtitleList(http, getWbiKeys, bvid, cid) {
  const params = { bvid, cid: String(cid) };
  const keys = await getWbiKeys();
  const signed = keys === void 0 ? params : wbiSign(params, keys);
  const data = await http.getJson("/x/player/wbi/v2", signed);
  return data.subtitle?.subtitles ?? [];
}
async function fetchSubtitleContent(http, subtitleUrl) {
  return await http.getJson(subtitleUrl);
}
async function fetchTags(http, bvid, cid) {
  const data = await http.getJson("/x/web-interface/view/detail/tag", {
    bvid,
    cid: String(cid)
  });
  return data.map((tag) => tag.tag_name ?? "").filter((name) => name !== "");
}

// src/api/search.ts
var SEARCH_TYPE_TO_PARAM = {
  video: "video",
  bangumi: "media_bangumi",
  cheese: "pgc",
  user: "bili_user",
  live_user: "live_user"
};
function stripHighlightTags(title) {
  return title.replace(/<[^>]+>/g, "");
}
function projectItem(type, item) {
  const numberField = (key) => {
    const value = item[key];
    return typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : void 0;
  };
  const bvid = typeof item.bvid === "string" ? item.bvid : void 0;
  const aid = numberField("aid");
  const epId = numberField("ep_id");
  const seasonId = numberField("season_id") ?? numberField("media_id");
  const mid = numberField("mid");
  const author = typeof item.author === "string" ? item.author : typeof item.uname === "string" ? item.uname : void 0;
  const cover = typeof item.pic === "string" ? item.pic : typeof item.cover === "string" ? item.cover : void 0;
  const description = typeof item.description === "string" ? item.description : typeof item.usign === "string" ? item.usign : void 0;
  const duration = typeof item.duration === "string" ? item.duration : void 0;
  const play = numberField("play");
  const danmaku = numberField("video_review");
  return {
    kind: type,
    title: stripHighlightTags(String(item.title ?? item.uname ?? "")),
    ...bvid !== void 0 ? { bvid } : {},
    ...aid !== void 0 ? { aid } : {},
    ...epId !== void 0 ? { epId } : {},
    ...seasonId !== void 0 ? { seasonId } : {},
    ...mid !== void 0 ? { mid } : {},
    ...author !== void 0 ? { author } : {},
    ...cover !== void 0 ? { cover } : {},
    ...duration !== void 0 ? { duration } : {},
    ...play !== void 0 ? { play } : {},
    ...danmaku !== void 0 ? { danmaku } : {},
    ...description !== void 0 ? { description } : {}
  };
}
function extractResults(data) {
  const result = data.result;
  if (Array.isArray(result)) return result;
  if (typeof result === "object" && result !== null) {
    for (const value of Object.values(result)) {
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}
async function searchBilibili(http, getWbiKeys, query, type, page) {
  const searchType = SEARCH_TYPE_TO_PARAM[type] ?? "video";
  const params = {
    search_type: searchType,
    keyword: query,
    page: String(page)
  };
  const keys = await getWbiKeys();
  const signed = keys === void 0 ? params : wbiSign(params, keys);
  const data = await http.getJson("/x/web-interface/wbi/search/type", signed);
  const total = typeof data.numResults === "number" ? data.numResults : 0;
  const results = extractResults(data).map((item) => projectItem(searchType, item));
  return { type: searchType, page, total, results };
}

// src/api/view.ts
function extractPrefixed(input, prefix) {
  let pathname = input;
  try {
    pathname = new URL(input).pathname;
  } catch {
  }
  for (const segment of pathname.split("/")) {
    if (segment.toLowerCase().startsWith(prefix)) {
      const rest = segment.slice(prefix.length);
      if (prefix === "bv") return segment;
      const value = Number.parseInt(rest, 10);
      if (!Number.isNaN(value)) return value;
    }
  }
  return void 0;
}
function extractUid(input) {
  try {
    const parsed = new URL(input);
    if (parsed.hostname !== "space.bilibili.com") return void 0;
    const uid = Number.parseInt(parsed.pathname.split("/")[1] ?? "", 10);
    return Number.isNaN(uid) ? void 0 : uid;
  } catch {
    return void 0;
  }
}
function parseTarget(input) {
  const raw = input.trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith("bv")) return { kind: "video", bvid: raw };
  if (lower.startsWith("av")) {
    const aid2 = Number.parseInt(raw.slice(2), 10);
    if (!Number.isNaN(aid2)) return { kind: "video", aid: aid2 };
  }
  if (lower.startsWith("ep")) {
    const epId2 = Number.parseInt(raw.slice(2), 10);
    if (!Number.isNaN(epId2)) return { kind: "bangumi", epId: epId2 };
  }
  if (lower.startsWith("ss")) {
    const seasonId2 = Number.parseInt(raw.slice(2), 10);
    if (!Number.isNaN(seasonId2)) return { kind: "bangumi", seasonId: seasonId2 };
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
  if (uid !== void 0) return { kind: "user", mid: uid };
  throw new Error(`\u65E0\u6CD5\u8BC6\u522B\u7684 B \u7AD9\u76EE\u6807: ${input}`);
}
async function resolveView(http, getWbiKeys, target) {
  switch (target.kind) {
    case "video": {
      const params = {};
      if (target.bvid !== void 0) params.bvid = target.bvid;
      if (target.aid !== void 0) params.aid = String(target.aid);
      const info = await http.getJson("/x/web-interface/view", params);
      return { kind: "video", info };
    }
    case "bangumi": {
      const params = {};
      if (target.epId !== void 0) params.ep_id = String(target.epId);
      if (target.seasonId !== void 0) params.season_id = String(target.seasonId);
      const info = await http.getJson("/pgc/view/web/season", params);
      const allEpisodes = [
        ...info.episodes,
        ...(info.section ?? []).flatMap((section) => section.episodes)
      ];
      const ep = target.epId === void 0 ? null : allEpisodes.find((item) => item.id === target.epId) ?? null;
      return { kind: "bangumi", ep, info };
    }
    case "cheese": {
      const params = {};
      if (target.epId !== void 0) params.ep_id = String(target.epId);
      if (target.seasonId !== void 0) params.season_id = String(target.seasonId);
      const info = await http.getJson("/pugv/view/web/season", params);
      const ep = target.epId === void 0 ? null : info.episodes.find((item) => item.id === target.epId) ?? null;
      return { kind: "cheese", ep, info };
    }
    case "user": {
      const keys = await getWbiKeys();
      const params = {
        mid: String(target.mid),
        pn: String(target.page ?? 1),
        ps: "30"
      };
      const signed = keys === void 0 ? params : wbiSign(params, keys);
      const info = await http.getJson("/x/space/wbi/arc/search", signed);
      return { kind: "user", info };
    }
  }
}

// src/api/index.ts
var WBI_KEYS_TTL_MS = 10 * 60 * 1e3;
var BiliClient = class {
  http;
  #keys;
  #keysAt = 0;
  constructor(options = {}) {
    this.http = new BiliHttp(options);
  }
  /**
   * 提供（缓存的）WBI keys；拿不到时返回 undefined，调用方降级为不带签名请求。
   * 首次获取失败不缓存，下次调用重试。
   */
  getWbiKeys = async () => {
    const now = Date.now();
    if (this.#keys !== void 0 && now - this.#keysAt < WBI_KEYS_TTL_MS) {
      return this.#keys;
    }
    try {
      const nav = await fetchNav(this.http);
      const keys = wbiKeysFromNav(nav);
      if (keys !== void 0) {
        this.#keys = keys;
        this.#keysAt = now;
      } else {
        this.#keys = void 0;
      }
      return keys;
    } catch {
      this.#keys = void 0;
      return void 0;
    }
  };
  /** 登录态（含 uname/mid）。 */
  async nav() {
    const nav = await fetchNav(this.http);
    return {
      isLogin: nav.isLogin,
      ...nav.mid !== void 0 ? { mid: nav.mid } : {},
      ...nav.uname !== void 0 ? { uname: nav.uname } : {}
    };
  }
  /** 解析用户输入并拉取完整信息。 */
  async view(input) {
    return resolveView(this.http, this.getWbiKeys, parseTarget(input));
  }
  /** 解析用户输入（不请求网络）。 */
  parseTarget(input) {
    return parseTarget(input);
  }
  /** 关键词搜索。 */
  search(query, type, page) {
    return searchBilibili(this.http, this.getWbiKeys, query, type, page);
  }
  /** 指定分 P 的 CC 字幕列表。 */
  subtitleList(bvid, cid) {
    return fetchSubtitleList(this.http, this.getWbiKeys, bvid, cid);
  }
  /** 字幕内容（绝对 URL）。 */
  subtitleContent(url) {
    return fetchSubtitleContent(this.http, url);
  }
  /** 视频标签。 */
  tags(bvid, cid) {
    return fetchTags(this.http, bvid, cid);
  }
  /** 音频流（dash 中按目标质量选择）。 */
  audioStream(kind, ids, desired) {
    return fetchAudioStream(this.http, this.getWbiKeys, kind, ids, desired);
  }
  /** 可用音频档位列表（info 工具展示用）。 */
  audioFormats(kind, ids) {
    return listAudioFormats(this.http, this.getWbiKeys, kind, ids);
  }
};

// src/download/manager.ts
import { mkdir as mkdir2, readFile, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2 } from "path";

// src/download/task.ts
import { createWriteStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { finished } from "stream/promises";

// src/errors.ts
var CODE_HINTS = {
  [-101]: "\u672A\u767B\u5F55\uFF1A\u8BE5\u63A5\u53E3\u9700\u8981\u767B\u5F55\u6001\uFF08\u914D\u7F6E sessdata \u540E\u53EF\u91CD\u8BD5\uFF09",
  [-104]: "\u6CA1\u6709\u6743\u9650\u8BBF\u95EE\u8BE5\u5185\u5BB9\uFF08\u53EF\u80FD\u9700\u8981\u767B\u5F55\u6216\u4E3A\u4ED8\u8D39/\u79C1\u5BC6\u5185\u5BB9\uFF09",
  [-352]: "\u89E6\u53D1\u98CE\u63A7\uFF1A\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u6216\u653E\u6162\u9891\u7387",
  [-400]: "\u8BF7\u6C42\u53C2\u6570\u9519\u8BEF",
  [-404]: "\u76EE\u6807\u4E0D\u5B58\u5728\u6216\u5DF2\u5931\u6548",
  [-412]: "\u8BF7\u6C42\u88AB\u62D2\u7EDD\uFF08\u53EF\u80FD\u88AB\u98CE\u63A7\u62E6\u622A\uFF09"
};
function friendlyBiliError(error) {
  if (error instanceof BiliError) {
    const hint = CODE_HINTS[error.code];
    return hint !== void 0 ? `${hint}\uFF08code ${error.code}\uFF09` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// src/download/task.ts
var DownloadTask = class {
  id;
  artifact;
  title;
  targetPath;
  createdAt = Date.now();
  state = "queued";
  bytesDone = 0;
  bytesTotal;
  error;
  finishedAt;
  /** 终态时 resolve（done/error/canceled）。 */
  settled;
  #settle;
  #run;
  #controller;
  constructor(init) {
    this.id = init.id;
    this.artifact = init.artifact;
    this.title = init.title;
    this.targetPath = init.targetPath;
    this.#run = init.run;
    this.settled = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }
  /** 开始执行（仅 queued 状态有效）。 */
  start() {
    if (this.state !== "queued") return;
    this.state = "downloading";
    const controller = new AbortController();
    this.#controller = controller;
    this.#run(controller.signal, (bytesDone, bytesTotal) => {
      this.bytesDone = bytesDone;
      this.bytesTotal = bytesTotal;
    }).then(() => {
      if (this.state === "downloading") {
        this.state = controller.signal.aborted ? "canceled" : "done";
        this.finishedAt = Date.now();
      }
    }).catch((error) => {
      if (controller.signal.aborted) {
        this.state = "canceled";
      } else {
        this.state = "error";
        this.error = errorMessage(error);
      }
      this.finishedAt = Date.now();
    }).finally(() => this.#settle());
  }
  /** 取消：中止进行中的下载；排队中的任务直接标记 canceled。 */
  cancel() {
    if (this.state === "queued") {
      this.state = "canceled";
      this.finishedAt = Date.now();
      this.#settle();
    } else if (this.state === "downloading") {
      this.#controller?.abort();
    }
  }
  /** 是否处于终态。 */
  get isTerminal() {
    return this.state === "done" || this.state === "error" || this.state === "canceled";
  }
  /** 转成可持久化的历史记录（仅终态）。 */
  toTerminalRecord() {
    if (this.state === "queued" || this.state === "downloading" || this.finishedAt === void 0) {
      return void 0;
    }
    const record = {
      id: this.id,
      artifact: this.artifact,
      title: this.title,
      targetPath: this.targetPath,
      state: this.state,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt
    };
    if (this.error !== void 0) record.error = this.error;
    if (this.bytesDone > 0) record.bytesDone = this.bytesDone;
    if (this.bytesTotal !== void 0) record.bytesTotal = this.bytesTotal;
    return record;
  }
};
function errorMessage(error) {
  return friendlyBiliError(error);
}
async function downloadToFile(http, url, targetPath, signal, onProgress) {
  await mkdir(dirname(targetPath), { recursive: true });
  const response = await http.request(url, { signal });
  if (!response.ok) {
    throw new BiliError(response.status, `HTTP ${response.status}`);
  }
  if (response.body === null) throw new Error("\u54CD\u5E94\u6CA1\u6709 body");
  const bytesTotal = Number(response.headers.get("content-length") ?? 0) || void 0;
  const file = createWriteStream(targetPath);
  let bytesDone = 0;
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw new Error("\u4E0B\u8F7D\u5DF2\u53D6\u6D88");
      await writeChunk(file, chunk);
      bytesDone += chunk.length;
      onProgress(bytesDone, bytesTotal);
    }
  } finally {
    file.end();
    await finished(file).catch(() => void 0);
  }
}
function writeChunk(file, chunk) {
  return new Promise((resolve, reject) => {
    file.write(chunk, (error) => error === null || error === void 0 ? resolve() : reject(error));
  });
}
async function writeTextFile(targetPath, content) {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

// src/download/manager.ts
var HISTORY_LIMIT = 200;
var DownloadManager = class {
  concurrency;
  historyPath;
  #tasks = /* @__PURE__ */ new Map();
  #queue = [];
  #active = 0;
  #history = [];
  constructor(options) {
    this.concurrency = options.concurrency;
    this.historyPath = options.historyPath;
    if (this.historyPath !== void 0) {
      void this.#loadHistory();
    }
  }
  /** 从磁盘恢复历史记录（失败静默——历史只是展示用途）。 */
  async #loadHistory() {
    if (this.historyPath === void 0) return;
    try {
      const content = await readFile(this.historyPath, "utf8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        this.#history = parsed.filter(
          (item) => typeof item === "object" && item !== null && "id" in item
        );
      }
    } catch {
    }
  }
  /** 入队一个任务并尝试启动。 */
  enqueue(task) {
    this.#tasks.set(task.id, task);
    this.#queue.push(task);
    this.pump();
  }
  /** 全部任务（含排队/进行中/已终态未删除）。 */
  list() {
    return [...this.#tasks.values()];
  }
  /** 按 id 取任务。 */
  get(id) {
    return this.#tasks.get(id);
  }
  /** 取消任务（进行中中止下载；排队中直接取消）。返回是否找到。 */
  cancel(id) {
    const task = this.#tasks.get(id);
    if (task === void 0) return false;
    task.cancel();
    return true;
  }
  /** 删除任务（取消并从注册表移除；终态任务已入历史）。返回是否找到。 */
  remove(id) {
    const task = this.#tasks.get(id);
    if (task === void 0) return false;
    task.cancel();
    this.#tasks.delete(id);
    const queueIndex = this.#queue.indexOf(task);
    if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
    return true;
  }
  /** 历史记录（最近的在前；含本次会话的终态任务与磁盘恢复的记录）。 */
  history() {
    return this.#history;
  }
  /** 调度：活跃数不足时依次启动排队中的任务。 */
  pump() {
    while (this.#active < this.concurrency) {
      const index = this.#queue.findIndex((task2) => task2.state === "queued");
      if (index < 0) break;
      const [task] = this.#queue.splice(index, 1);
      if (task === void 0) break;
      this.#active += 1;
      task.start();
      task.settled.then(() => {
        this.#active -= 1;
        this.#record(task);
        this.pump();
      });
    }
  }
  /** 任务进入终态后记入历史并（尽量）落盘。 */
  #record(task) {
    const record = task.toTerminalRecord();
    if (record === void 0) return;
    this.#history.unshift(record);
    if (this.#history.length > HISTORY_LIMIT) {
      this.#history.length = HISTORY_LIMIT;
    }
    const historyPath = this.historyPath;
    if (historyPath === void 0) return;
    void (async () => {
      try {
        await mkdir2(dirname2(historyPath), { recursive: true });
        await writeFile2(historyPath, JSON.stringify(this.#history, null, 2), "utf8");
      } catch {
      }
    })();
  }
};

// src/download/planner.ts
import { randomUUID } from "crypto";
import { join } from "path";

// src/download/naming.ts
function filenameFilter(value) {
  const mapped = value.split("").map((char) => {
    switch (char) {
      case "\\":
      case "/":
      case "\n":
        return " ";
      case ":":
        return "\uFF1A";
      case "*":
        return "\u2B50";
      case "?":
        return "\uFF1F";
      case '"':
        return "'";
      case "<":
        return "\u300A";
      case ">":
        return "\u300B";
      case "|":
        return "\u4E28";
      default:
        return char;
    }
  }).join("");
  return mapped.trim().replace(/\.+$/, "").trim();
}
function renderName(template, vars) {
  const replaced = template.replace(/\{(\w+)\}/g, (match, token) => vars[token] ?? "");
  const segments = replaced.split("/").map((segment) => filenameFilter(segment));
  return segments.join("/");
}

// src/download/formats.ts
function srtTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds * 1e3));
  const ms = total % 1e3;
  const s = Math.floor(total / 1e3) % 60;
  const m = Math.floor(total / 6e4) % 60;
  const h = Math.floor(total / 36e5);
  const pad = (value, width) => String(value).padStart(width, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}
function subtitleToSrt(body) {
  return body.map(
    (item, index) => `${index + 1}
${srtTimestamp(item.from)} --> ${srtTimestamp(item.to)}
${item.content}
`
  ).join("\n");
}
function cleanCoverUrl(url) {
  const withoutAt = url.split("@")[0] ?? url;
  const queryIndex = withoutAt.indexOf("?");
  return queryIndex >= 0 ? withoutAt.slice(0, queryIndex) : withoutAt;
}
function coverExtension(url) {
  const clean = cleanCoverUrl(url);
  const match = /\.(jpe?g|png|webp)$/i.exec(clean);
  return match !== null ? match[1].toLowerCase() : "jpg";
}
function artifactSuffix(artifact, audioQuality) {
  switch (artifact) {
    case "audio":
      return audioQuality === "HiRes" ? ".flac" : ".m4a";
    case "cover":
      return "";
    case "subtitle":
      return ".srt";
    case "danmaku":
      return ".xml";
    case "json":
      return ".info.json";
    case "nfo":
      return ".nfo";
  }
}
function unescapeXml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10))).replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}
function danmakuXmlToJson(xml) {
  const items = [];
  const pattern = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const fields = match[1].split(",");
    const time = Number.parseFloat(fields[0] ?? "0");
    const mode = Number.parseInt(fields[1] ?? "1", 10);
    const fontsize = Number.parseInt(fields[2] ?? "25", 10);
    const color = Number.parseInt(fields[3] ?? "16777215", 10);
    if (Number.isNaN(time) || Number.isNaN(mode)) continue;
    items.push({ time, mode, fontsize, color, text: unescapeXml(match[2]) });
  }
  return items;
}

// src/download/nfo.ts
function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function buildNfo(input) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<movie>",
    `  <title>${escapeXml(input.title)}</title>`
  ];
  if (input.uniqueId !== void 0 && input.uniqueId !== "") {
    lines.push(`  <uniqueid type="bilibili">${escapeXml(input.uniqueId)}</uniqueid>`);
  }
  if (input.plot !== void 0 && input.plot !== "") {
    lines.push(`  <plot>${escapeXml(input.plot)}</plot>`);
  }
  if (input.pubdate !== void 0 && input.pubdate !== "") {
    lines.push(`  <premiered>${escapeXml(input.pubdate)}</premiered>`);
  }
  if (input.poster !== void 0 && input.poster !== "") {
    lines.push("  <art>", `    <poster>${escapeXml(input.poster)}</poster>`, "  </art>");
  }
  lines.push("</movie>");
  return `${lines.join("\n")}
`;
}

// src/download/planner.ts
function dateString(unixSeconds) {
  const date = new Date(unixSeconds * 1e3);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function planUnits(result, page) {
  switch (result.kind) {
    case "video": {
      const info = result.info;
      const pages = page === void 0 ? info.pages : info.pages.filter((item) => item.page === page);
      if (pages.length === 0) {
        throw new Error(`\u6CA1\u6709 page=${page} \u7684\u5206P\uFF08\u8BE5\u89C6\u9891\u5171 ${info.pages.length} \u4E2A\u5206P\uFF09`);
      }
      const pubdate = dateString(info.pubdate);
      const up = info.owner.name;
      const title = info.title;
      const bvid = info.bvid;
      const coverUrl = info.pic;
      const infoJson = info;
      return pages.map((item) => ({
        kind: "video",
        title,
        bvid,
        cid: item.cid,
        coverUrl,
        infoJson,
        vars: { title, bvid, part: `P${item.page}`, pubdate, up }
      }));
    }
    case "bangumi": {
      const info = result.info;
      const eps = result.ep !== null ? [result.ep] : info.episodes;
      if (eps.length === 0) throw new Error("\u8BE5\u756A\u5267\u6CA1\u6709\u5267\u96C6");
      const seasonTitle = info.season_title;
      const up = info.up_info?.uname;
      const infoJson = info;
      return eps.map((ep) => {
        const bvid = ep.bvid ?? `EP${ep.ep_id}`;
        return {
          kind: "bangumi",
          title: `${seasonTitle} ${ep.title}`,
          epId: ep.ep_id,
          cid: ep.cid,
          bvid,
          coverUrl: ep.cover,
          infoJson,
          vars: {
            title: ep.title,
            bvid,
            part: ep.long_title ?? ep.title,
            ...ep.pub_time !== void 0 ? { pubdate: dateString(ep.pub_time) } : {},
            ...up !== void 0 ? { up } : {}
          }
        };
      });
    }
    case "cheese": {
      const info = result.info;
      const eps = result.ep !== null ? [result.ep] : info.episodes;
      if (eps.length === 0) throw new Error("\u8BE5\u8BFE\u7A0B\u6CA1\u6709\u8BFE\u65F6");
      const seasonTitle = info.title;
      const up = info.up_info?.uname;
      const infoJson = info;
      return eps.map((ep) => {
        const bvid = `EP${ep.ep_id}`;
        return {
          kind: "cheese",
          title: `${seasonTitle} ${ep.title}`,
          epId: ep.ep_id,
          cid: ep.cid,
          bvid,
          ...ep.cover !== void 0 ? { coverUrl: ep.cover } : {},
          infoJson,
          vars: { title: ep.title, bvid, part: ep.title, ...up !== void 0 ? { up } : {} }
        };
      });
    }
    case "user":
      throw new Error("UP \u7A7A\u95F4\u4E0D\u662F\u53EF\u4E0B\u8F7D\u76EE\u6807\uFF0C\u8BF7\u5148\u6307\u5B9A\u5177\u4F53\u89C6\u9891\uFF08bvid / av / ep / ss\uFF09");
  }
}
function pickSubtitle(list) {
  if (list.length === 0) return void 0;
  const prefer = (lan) => list.find((item) => item.lan.toLowerCase() === lan.toLowerCase());
  return prefer("zh-CN") ?? prefer("ai-zh") ?? prefer("zh-TW") ?? (list.find((item) => item.lan.toLowerCase().startsWith("zh")) ?? list[0]);
}
function buildTask(client, opts, unit, artifact, format = "xml") {
  const base = renderName(opts.namingTemplate, unit.vars);
  const suffix = artifact === "danmaku" && format === "json" ? ".json" : artifactSuffix(artifact, opts.audioQuality);
  const targetPath = artifact === "cover" ? join(opts.downloadDir, `${base}.${coverExtension(unit.coverUrl ?? "")}`) : join(opts.downloadDir, `${base}${suffix}`);
  const id = randomUUID();
  const run = createRun(client, opts, unit, artifact, targetPath, format);
  return new DownloadTask({
    id,
    artifact,
    title: `${unit.title}\uFF08${artifact}\uFF09`,
    targetPath,
    run
  });
}
function createRun(client, opts, unit, artifact, targetPath, format) {
  return async (signal, onProgress) => {
    switch (artifact) {
      case "audio": {
        let ids;
        if (unit.kind === "video") {
          if (unit.bvid === void 0 || unit.cid === void 0) {
            throw new Error("\u8BE5\u89C6\u9891\u7F3A\u5C11 bvid/cid");
          }
          ids = { bvid: unit.bvid, cid: unit.cid };
        } else {
          if (unit.epId === void 0) throw new Error("\u8BE5\u96C6\u7F3A\u5C11 ep_id");
          ids = { epId: unit.epId };
        }
        const selected = await client.audioStream(unit.kind, ids, opts.audioQuality);
        if (selected === null) {
          throw new Error("\u6CA1\u6709\u53EF\u7528\u7684\u97F3\u9891\u6D41\uFF08\u53EF\u80FD\u9700\u8981\u767B\u5F55\u6216\u8BE5\u89C6\u9891\u65E0\u97F3\u9891\u8F68\uFF09");
        }
        const candidates = [selected.url, ...selected.backupUrls ?? []];
        let lastError;
        for (const candidate of candidates) {
          try {
            await downloadToFile(client.http, candidate, targetPath, signal, onProgress);
            return;
          } catch (error) {
            if (signal.aborted) throw error;
            lastError = error;
          }
        }
        throw lastError ?? new Error("\u97F3\u9891\u6D41\u4E0B\u8F7D\u5931\u8D25");
      }
      case "cover": {
        if (unit.coverUrl === void 0 || unit.coverUrl === "") {
          throw new Error("\u8BE5\u76EE\u6807\u6CA1\u6709\u5C01\u9762\u56FE");
        }
        await downloadToFile(client.http, cleanCoverUrl(unit.coverUrl), targetPath, signal, onProgress);
        return;
      }
      case "subtitle": {
        if (unit.bvid === void 0 || unit.cid === void 0) {
          throw new Error("\u8BE5\u96C6\u6CA1\u6709 bvid/cid\uFF0C\u65E0\u6CD5\u53D6\u5B57\u5E55");
        }
        const list = await client.subtitleList(unit.bvid, unit.cid);
        const chosen = pickSubtitle(list);
        if (chosen === void 0) throw new Error("\u8BE5\u89C6\u9891\u6CA1\u6709 CC \u5B57\u5E55");
        const body = await client.subtitleContent(chosen.subtitle_url);
        const srt = subtitleToSrt(body.body);
        await writeTextFile(targetPath, srt);
        onProgress(Buffer.byteLength(srt), void 0);
        return;
      }
      case "danmaku": {
        if (unit.cid === void 0) throw new Error("\u6CA1\u6709 cid\uFF0C\u65E0\u6CD5\u53D6\u5F39\u5E55");
        const xml = await client.http.getText(
          `https://api.bilibili.com/x/v1/dm/list.so?oid=${unit.cid}`
        );
        const content = format === "json" ? JSON.stringify(danmakuXmlToJson(xml), null, 2) : xml;
        await writeTextFile(targetPath, content);
        onProgress(Buffer.byteLength(content), void 0);
        return;
      }
      case "json": {
        const json = JSON.stringify(unit.infoJson, null, 2);
        await writeTextFile(targetPath, json);
        onProgress(Buffer.byteLength(json), void 0);
        return;
      }
      case "nfo": {
        const info = unit.infoJson;
        const title = typeof info.title === "string" ? info.title : typeof info.season_title === "string" ? info.season_title : unit.vars.title ?? "";
        const plot = typeof info.desc === "string" ? info.desc : typeof info.evaluate === "string" ? info.evaluate : "";
        const posterBase = renderName(opts.namingTemplate, unit.vars);
        const poster = `${posterBase.split("/").pop()}.${coverExtension(unit.coverUrl ?? "")}`;
        const nfo = buildNfo({
          title,
          ...unit.vars.bvid !== void 0 ? { uniqueId: unit.vars.bvid } : {},
          plot,
          poster,
          ...unit.vars.pubdate !== void 0 ? { pubdate: unit.vars.pubdate } : {}
        });
        await writeTextFile(targetPath, nfo);
        onProgress(Buffer.byteLength(nfo), void 0);
        return;
      }
    }
  };
}

// src/defaults.ts
import { homedir } from "os";
import { join as join2 } from "path";
var DEFAULT_DOWNLOAD_DIR = join2(homedir(), "Downloads", "bilibili");
var DEFAULT_NAMING_TEMPLATE = "{title}/{bvid}_{part}";
var DEFAULT_AUDIO_QUALITY = "192K";
var DEFAULT_ARTIFACTS = ["audio", "cover", "subtitle", "danmaku", "json", "nfo"];

// src/cli.ts
var USAGE = `shushu \u2014 B \u7AD9\u5DE5\u5177\uFF08\u53D4\u53D4\uFF09

\u7528\u6CD5\uFF1A
  shushu search <\u5173\u952E\u8BCD> [--type video|bangumi|cheese|user|live_user] [--page N]
  shushu info <bvid|av \u53F7|ep|ss|\u5B8C\u6574 URL>
  shushu download <bvid|av \u53F7|ep|ss|\u5B8C\u6574 URL>
          [--artifact audio|cover|subtitle|danmaku|json|nfo] [--page N]
          [--quality 64K|132K|192K|Dolby|HiRes] [--format xml|json]
          [--dir <\u4E0B\u8F7D\u76EE\u5F55>]
     \u7701\u7565 --artifact \u65F6\u4E0B\u8F7D\u9ED8\u8BA4\u96C6\u5408\uFF08audio/cover/subtitle/danmaku/json/nfo\uFF09\u3002
`;
function flag(argv, key, fallback) {
  const index = argv.indexOf(key);
  if (index >= 0 && argv[index + 1] !== void 0) return argv[index + 1];
  return fallback;
}
function positional(argv) {
  return argv.find((arg) => !arg.startsWith("--"));
}
function renderSearch(result) {
  const lines = [];
  lines.push(`\u641C\u7D22\uFF08${result.type}\uFF09\u7B2C ${result.page} \u9875\uFF0C\u5171 ${result.total} \u6761\uFF1A`);
  result.results.forEach((item, index) => {
    const id = item.bvid ?? `#${index}`;
    lines.push(
      `  ${index + 1}. [${item.kind}] ${item.title}` + (item.author !== void 0 ? ` \u2014 ${item.author}` : "") + (item.duration !== void 0 ? `\uFF08${item.duration}\uFF09` : "") + `
     ${id}`
    );
  });
  return lines.join("\n");
}
function renderView(view) {
  const lines = [];
  if (view.kind === "video") {
    const info = view.info;
    lines.push(info.title);
    lines.push(`  bvid: ${info.bvid}  aid: ${info.aid}`);
    lines.push(`  \u65F6\u957F: ${info.duration}s  UP: ${info.owner?.name ?? "?"}`);
    if (info.pages.length > 1) {
      lines.push(`  \u5206P: ${info.pages.length} \u4E2A`);
      info.pages.forEach((p) => {
        lines.push(`    ${p.page}. ${p.part}\uFF08${p.duration}s\uFF09`);
      });
    } else if (info.pages.length === 1) {
      lines.push(
        `  \u5206P: ${info.pages[0]?.part ?? "-"}\uFF08${info.pages[0]?.duration ?? 0}s\uFF09`
      );
    }
    if (info.desc.length > 0) lines.push(`  \u7B80\u4ECB: ${info.desc.slice(0, 120)}`);
  } else if (view.kind === "bangumi" || view.kind === "cheese") {
    const info = view.info;
    lines.push(info.title ?? info.season_title ?? "");
    lines.push(`  \u7C7B\u578B: ${view.kind}`);
    if (view.ep !== null && view.ep !== void 0) {
      const ep = view.ep;
      lines.push(
        `  \u96C6: ${ep.title ?? ""}${ep.long_title !== void 0 ? `\uFF08${ep.long_title}\uFF09` : ""}`
      );
    }
  } else {
    const info = view.info;
    lines.push(info.title ?? "");
    lines.push(`  \u7C7B\u578B: user`);
  }
  return lines.join("\n");
}
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === void 0 || cmd === "--help" || cmd === "help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const client = new BiliClient();
  if (cmd === "search") {
    const query = positional(argv.slice(1));
    if (query === void 0) {
      process.stderr.write("\u7528\u6CD5\uFF1Ashushu search <\u5173\u952E\u8BCD>\n");
      process.exitCode = 1;
      return;
    }
    const type = flag(argv.slice(1), "--type", "video");
    const page = Number.parseInt(flag(argv.slice(1), "--page", "1"), 10) || 1;
    const result = await client.search(query, type, page);
    process.stdout.write(renderSearch(result) + "\n");
    return;
  }
  if (cmd === "info") {
    const target = positional(argv.slice(1));
    if (target === void 0) {
      process.stderr.write("\u7528\u6CD5\uFF1Ashushu info <bvid|av|ep|ss|URL>\n");
      process.exitCode = 1;
      return;
    }
    const view = await client.view(target);
    process.stdout.write(renderView(view) + "\n");
    return;
  }
  if (cmd === "download") {
    const target = positional(argv.slice(1));
    if (target === void 0) {
      process.stderr.write("\u7528\u6CD5\uFF1Ashushu download <bvid|av|ep|ss|URL>\n");
      process.exitCode = 1;
      return;
    }
    const rest = argv.slice(1);
    const artifact = flag(rest, "--artifact", "");
    const artifacts = artifact.length > 0 ? [artifact] : [...DEFAULT_ARTIFACTS];
    const pageText = flag(rest, "--page", "");
    const page = pageText.length > 0 ? Number.parseInt(pageText, 10) : void 0;
    const quality = flag(rest, "--quality", DEFAULT_AUDIO_QUALITY);
    const format = flag(rest, "--format", "xml");
    const downloadDir = flag(rest, "--dir", DEFAULT_DOWNLOAD_DIR);
    const view = await client.view(target);
    const units = planUnits(view, page);
    const opts = {
      downloadDir,
      namingTemplate: DEFAULT_NAMING_TEMPLATE,
      audioQuality: quality
    };
    const manager = new DownloadManager({ concurrency: 3 });
    const tasks = [];
    for (const unit of units) {
      for (const kind of artifacts) {
        const task = buildTask(client, opts, unit, kind, format);
        manager.enqueue(task);
        tasks.push(task);
      }
    }
    await Promise.all(tasks.map((task) => task.settled));
    for (const task of tasks) {
      const mark = task.state === "done" ? "\u2713" : "\u2717";
      process.stdout.write(`${mark} ${task.title}
   ${task.targetPath}
`);
    }
    return;
  }
  process.stderr.write(`\u672A\u77E5\u547D\u4EE4\uFF1A${cmd}

${USAGE}
`);
  process.exitCode = 1;
}
void main();
