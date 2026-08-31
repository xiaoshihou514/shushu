/**
 * 下载产物的格式转换与命名辅助：字幕 json→srt、封面 URL 清理、扩展名。
 * 纯函数，可单测。
 */

import type { ArtifactKind } from "./task.ts";

/** 秒数 → SRT 时间戳（`HH:MM:SS,mmm`）。 */
export function srtTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** 字幕 body（`{from, to, content}`）→ SRT 文本。 */
export function subtitleToSrt(body: Array<{ from: number; to: number; content: string }>): string {
  return body
    .map(
      (item, index) =>
        `${index + 1}\n${srtTimestamp(item.from)} --> ${srtTimestamp(item.to)}\n${item.content}\n`,
    )
    .join("\n");
}

/**
 * 清理封面 URL：去掉 `@...` 缩略图参数与查询串，取原图地址。
 * 对应原版"最高清、无压缩的原始封面图"。
 */
export function cleanCoverUrl(url: string): string {
  const withoutAt = url.split("@")[0] ?? url;
  const queryIndex = withoutAt.indexOf("?");
  return queryIndex >= 0 ? withoutAt.slice(0, queryIndex) : withoutAt;
}

/** 从 URL 路径提取图片扩展名（存在且为常见图片格式时）。 */
export function coverExtension(url: string): string {
  const clean = cleanCoverUrl(url);
  const match = /\.(jpe?g|png|webp)$/i.exec(clean);
  return match !== null ? match[1]!.toLowerCase() : "jpg";
}

/**
 * 产物文件后缀（拼在命名模板渲染结果之后）。
 * 音频按期望档位定扩展名：HiRes → `.flac`，其余 → `.m4a`
 * （若实际回退到其他档位，扩展名可能与编码不一致——M2 已知取舍）。
 */
export function artifactSuffix(artifact: ArtifactKind, audioQuality?: string): string {
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

/** 弹幕 XML 反转义（&amp; &lt; &gt; &quot; &#39; 与数字实体）。 */
export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/** 一条弹幕的 json 表示。 */
export interface DanmakuItem {
  /** 视频内时间（秒）。 */
  time: number;
  /** 弹幕模式（1 滚动 / 4 底部 / 5 顶部 等）。 */
  mode: number;
  /** 字号（18 / 25 / 36）。 */
  fontsize: number;
  /** 颜色（十进制 RGB）。 */
  color: number;
  /** 弹幕文本。 */
  text: string;
}

/**
 * 弹幕 XML（`/x/v1/dm/list.so` 的 gzip→文本）→ json 数组。
 * 每个 `<d p="time,mode,fontsize,color,...">text</d>` 映射为一条。
 */
export function danmakuXmlToJson(xml: string): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  const pattern = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const fields = match[1]!.split(",");
    const time = Number.parseFloat(fields[0] ?? "0");
    const mode = Number.parseInt(fields[1] ?? "1", 10);
    const fontsize = Number.parseInt(fields[2] ?? "25", 10);
    const color = Number.parseInt(fields[3] ?? "16777215", 10);
    if (Number.isNaN(time) || Number.isNaN(mode)) continue;
    items.push({ time, mode, fontsize, color, text: unescapeXml(match[2]!) });
  }
  return items;
}
