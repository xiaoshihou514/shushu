/**
 * NFO 元信息生成（emby/kodi 风格 movie 模板，M4 简化版）。
 * 供 `bili_download artifact=nfo` 使用；纯函数，可单测。
 */

/** XML 转义（文本内容安全）。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface NfoInput {
  /** 标题。 */
  title: string;
  /** 唯一标识（bvid / EP 号），写入 uniqueid。 */
  uniqueId?: string;
  /** 简介/剧情（plot）。 */
  plot?: string;
  /** 海报文件名（相对同目录，指向封面产物）。 */
  poster?: string;
  /** 发布日期 `YYYY-MM-DD`。 */
  pubdate?: string;
}

/** 生成 movie 风格 NFO（空字段不输出）。 */
export function buildNfo(input: NfoInput): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<movie>",
    `  <title>${escapeXml(input.title)}</title>`,
  ];
  if (input.uniqueId !== undefined && input.uniqueId !== "") {
    lines.push(`  <uniqueid type="bilibili">${escapeXml(input.uniqueId)}</uniqueid>`);
  }
  if (input.plot !== undefined && input.plot !== "") {
    lines.push(`  <plot>${escapeXml(input.plot)}</plot>`);
  }
  if (input.pubdate !== undefined && input.pubdate !== "") {
    lines.push(`  <premiered>${escapeXml(input.pubdate)}</premiered>`);
  }
  if (input.poster !== undefined && input.poster !== "") {
    lines.push("  <art>", `    <poster>${escapeXml(input.poster)}</poster>`, "  </art>");
  }
  lines.push("</movie>");
  return `${lines.join("\n")}\n`;
}
