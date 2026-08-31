/**
 * 下载规划：把解析结果（ViewResult）拆成可下载的单元（分P/单集），
 * 并为每个「单元 × 产物」构建 DownloadTask。命名在入队时确定，
 * 实际取流/取内容在任务的 run 闭包里后台执行。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BiliClient } from "../api/index.ts";
import type { AudioQualityName, SubtitleDetail, ViewResult } from "../types.ts";
import { renderName, type NameToken } from "./naming.ts";
import {
  artifactSuffix,
  cleanCoverUrl,
  coverExtension,
  danmakuXmlToJson,
  subtitleToSrt,
} from "./formats.ts";
import { buildNfo } from "./nfo.ts";
import { DownloadTask, downloadToFile, writeTextFile, type ArtifactKind, type DownloadTaskInit } from "./task.ts";

/** 一个可下载单元：视频的某个分P，或番剧/课程的某一集。 */
export interface DownloadUnit {
  kind: "video" | "bangumi" | "cheese";
  /** 展示名（含上级标题）。 */
  title: string;
  /** 命名模板变量。 */
  vars: Partial<Record<NameToken, string>>;
  bvid?: string;
  cid?: number;
  epId?: number;
  coverUrl?: string;
  /** json 产物保存的原始信息对象。 */
  infoJson: Record<string, unknown>;
}

/** 规划参数（来自插件 Config）。 */
export interface PlannerOptions {
  downloadDir: string;
  namingTemplate: string;
  audioQuality: AudioQualityName;
}

/** Unix 秒 → `YYYY-MM-DD`。 */
function dateString(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 把解析结果拆成下载单元。`page` 仅对 video 生效（指定分P）；
 * bangumi/cheese 的 ep 目标给单集，ss/season 目标给全部集。
 *
 * @throws user 目标不可下载；video 且 page 不存在时抛错。
 */
export function planUnits(result: ViewResult, page?: number): DownloadUnit[] {
  switch (result.kind) {
    case "video": {
      const info = result.info;
      const pages =
        page === undefined ? info.pages : info.pages.filter((item) => item.page === page);
      if (pages.length === 0) {
        throw new Error(`没有 page=${page} 的分P（该视频共 ${info.pages.length} 个分P）`);
      }
      const pubdate = dateString(info.pubdate);
      const up = info.owner.name;
      const title = info.title;
      const bvid = info.bvid;
      const coverUrl = info.pic;
      const infoJson = info as unknown as Record<string, unknown>;
      return pages.map((item) => ({
        kind: "video" as const,
        title,
        bvid,
        cid: item.cid,
        coverUrl,
        infoJson,
        vars: { title, bvid, part: `P${item.page}`, pubdate, up },
      }));
    }
    case "bangumi": {
      const info = result.info;
      const eps = result.ep !== null ? [result.ep] : info.episodes;
      if (eps.length === 0) throw new Error("该番剧没有剧集");
      const seasonTitle = info.season_title;
      const up = info.up_info?.uname;
      const infoJson = info as unknown as Record<string, unknown>;
      return eps.map((ep) => {
        const bvid = ep.bvid ?? `EP${ep.ep_id}`;
        return {
          kind: "bangumi" as const,
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
            ...(ep.pub_time !== undefined ? { pubdate: dateString(ep.pub_time) } : {}),
            ...(up !== undefined ? { up } : {}),
          },
        };
      });
    }
    case "cheese": {
      const info = result.info;
      const eps = result.ep !== null ? [result.ep] : info.episodes;
      if (eps.length === 0) throw new Error("该课程没有课时");
      const seasonTitle = info.title;
      const up = info.up_info?.uname;
      const infoJson = info as unknown as Record<string, unknown>;
      return eps.map((ep) => {
        const bvid = `EP${ep.ep_id}`;
        return {
          kind: "cheese" as const,
          title: `${seasonTitle} ${ep.title}`,
          epId: ep.ep_id,
          cid: ep.cid,
          bvid,
          ...(ep.cover !== undefined ? { coverUrl: ep.cover } : {}),
          infoJson,
          vars: { title: ep.title, bvid, part: ep.title, ...(up !== undefined ? { up } : {}) },
        };
      });
    }
    case "user":
      throw new Error("UP 空间不是可下载目标，请先指定具体视频（bvid / av / ep / ss）");
  }
}

/** 从字幕列表挑一档：中文优先（zh-CN → ai-zh → zh-TW），否则第一个。 */
export function pickSubtitle(list: SubtitleDetail[]): SubtitleDetail | undefined {
  if (list.length === 0) return undefined;
  const prefer = (lan: string): SubtitleDetail | undefined =>
    list.find((item) => item.lan.toLowerCase() === lan.toLowerCase());
  return (
    prefer("zh-CN") ??
    prefer("ai-zh") ??
    prefer("zh-TW") ??
    (list.find((item) => item.lan.toLowerCase().startsWith("zh")) ?? list[0])
  );
}

/** 弹幕产物格式。 */
export type DanmakuFormat = "xml" | "json";

/**
 * 为「单元 × 产物」构建一个下载任务。目标路径入队时确定（命名确定）；
 * 取流/取内容的网络调用放进行闭包，失败时任务进入 error 态（不阻塞入队）。
 *
 * @param format - 仅 danmaku 生效：xml（默认，原始 XML）或 json（解析后的数组）。
 */
export function buildTask(
  client: BiliClient,
  opts: PlannerOptions,
  unit: DownloadUnit,
  artifact: ArtifactKind,
  format: DanmakuFormat = "xml",
): DownloadTask {
  const base = renderName(opts.namingTemplate, unit.vars);
  const suffix =
    artifact === "danmaku" && format === "json" ? ".json" : artifactSuffix(artifact, opts.audioQuality);
  const targetPath =
    artifact === "cover"
      ? join(opts.downloadDir, `${base}.${coverExtension(unit.coverUrl ?? "")}`)
      : join(opts.downloadDir, `${base}${suffix}`);
  const id = randomUUID();
  const run = createRun(client, opts, unit, artifact, targetPath, format);
  return new DownloadTask({
    id,
    artifact,
    title: `${unit.title}（${artifact}）`,
    targetPath,
    run,
  });
}

/** 产物执行体。 */
function createRun(
  client: BiliClient,
  opts: PlannerOptions,
  unit: DownloadUnit,
  artifact: ArtifactKind,
  targetPath: string,
  format: DanmakuFormat,
): DownloadTaskInit["run"] {
  return async (signal, onProgress) => {
    switch (artifact) {
      case "audio": {
        let ids: { bvid?: string; cid?: number; epId?: number };
        if (unit.kind === "video") {
          if (unit.bvid === undefined || unit.cid === undefined) {
            throw new Error("该视频缺少 bvid/cid");
          }
          ids = { bvid: unit.bvid, cid: unit.cid };
        } else {
          if (unit.epId === undefined) throw new Error("该集缺少 ep_id");
          ids = { epId: unit.epId };
        }
        const selected = await client.audioStream(unit.kind, ids, opts.audioQuality);
        if (selected === null) {
          throw new Error("没有可用的音频流（可能需要登录或该视频无音频轨）");
        }
        // 依次尝试 base_url 与备用镜像（CDN 可能被网络环境拦截，对齐原版 backup 优先探测）
        const candidates = [selected.url, ...(selected.backupUrls ?? [])];
        let lastError: unknown;
        for (const candidate of candidates) {
          try {
            await downloadToFile(client.http, candidate, targetPath, signal, onProgress);
            return;
          } catch (error) {
            if (signal.aborted) throw error;
            lastError = error;
          }
        }
        throw lastError ?? new Error("音频流下载失败");
      }
      case "cover": {
        if (unit.coverUrl === undefined || unit.coverUrl === "") {
          throw new Error("该目标没有封面图");
        }
        await downloadToFile(client.http, cleanCoverUrl(unit.coverUrl), targetPath, signal, onProgress);
        return;
      }
      case "subtitle": {
        if (unit.bvid === undefined || unit.cid === undefined) {
          throw new Error("该集没有 bvid/cid，无法取字幕");
        }
        const list = await client.subtitleList(unit.bvid, unit.cid);
        const chosen = pickSubtitle(list);
        if (chosen === undefined) throw new Error("该视频没有 CC 字幕");
        const body = await client.subtitleContent(chosen.subtitle_url);
        const srt = subtitleToSrt(body.body);
        await writeTextFile(targetPath, srt);
        onProgress(Buffer.byteLength(srt), undefined);
        return;
      }
      case "danmaku": {
        if (unit.cid === undefined) throw new Error("没有 cid，无法取弹幕");
        const xml = await client.http.getText(
          `https://api.bilibili.com/x/v1/dm/list.so?oid=${unit.cid}`,
        );
        const content =
          format === "json" ? JSON.stringify(danmakuXmlToJson(xml), null, 2) : xml;
        await writeTextFile(targetPath, content);
        onProgress(Buffer.byteLength(content), undefined);
        return;
      }
      case "json": {
        const json = JSON.stringify(unit.infoJson, null, 2);
        await writeTextFile(targetPath, json);
        onProgress(Buffer.byteLength(json), undefined);
        return;
      }
      case "nfo": {
        const info = unit.infoJson;
        const title =
          typeof info.title === "string"
            ? info.title
            : typeof info.season_title === "string"
              ? info.season_title
              : (unit.vars.title ?? "");
        const plot =
          typeof info.desc === "string"
            ? info.desc
            : typeof info.evaluate === "string"
              ? info.evaluate
              : "";
        const posterBase = renderName(opts.namingTemplate, unit.vars);
        const poster = `${posterBase.split("/").pop()}.${coverExtension(unit.coverUrl ?? "")}`;
        const nfo = buildNfo({
          title,
          ...(unit.vars.bvid !== undefined ? { uniqueId: unit.vars.bvid } : {}),
          plot,
          poster,
          ...(unit.vars.pubdate !== undefined ? { pubdate: unit.vars.pubdate } : {}),
        });
        await writeTextFile(targetPath, nfo);
        onProgress(Buffer.byteLength(nfo), undefined);
        return;
      }
    }
  };
}
