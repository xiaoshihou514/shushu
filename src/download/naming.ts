/**
 * 下载命名：非法字符过滤与命名模板渲染（移植原版 `utils.rs filename_filter`
 * 与 config 的 dir_fmt 模板）。纯函数，可单测。
 */

/** 文件名非法字符替换（逐字移植 utils.rs `filename_filter`）。 */
export function filenameFilter(value: string): string {
  const mapped = value
    .split("")
    .map((char) => {
      switch (char) {
        case "\\":
        case "/":
        case "\n":
          return " ";
        case ":":
          return "：";
        case "*":
          return "⭐";
        case "?":
          return "？";
        case '"':
          return "'";
        case "<":
          return "《";
        case ">":
          return "》";
        case "|":
          return "丨";
        default:
          return char;
      }
    })
    .join("");
  return mapped.trim().replace(/\.+$/, "").trim();
}

/** 可用的命名模板令牌。 */
export type NameToken = "title" | "bvid" | "part" | "pubdate" | "up";

/**
 * 渲染命名模板：把 `{token}` 替换为对应值后逐路径段做 {@link filenameFilter}。
 * 未识别的 `{xxx}` 保留原样（不静默吞掉拼写错误）。
 *
 * @param template - 如 `{title}/{bvid}_{part}`。
 * @param vars - 令牌 → 值（值缺失时替换为空串）。
 * @returns 过滤后的路径（可能为多段目录 + 文件名）。
 */
export function renderName(template: string, vars: Partial<Record<NameToken, string>>): string {
  const replaced = template.replace(/\{(\w+)\}/g, (match, token: string) => vars[token as NameToken] ?? "");
  const segments = replaced.split("/").map((segment) => filenameFilter(segment));
  return segments.join("/");
}
