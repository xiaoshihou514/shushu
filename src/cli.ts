import { BiliClient } from "./api/index.ts";
import { DownloadManager } from "./download/manager.ts";
import {
  buildTask,
  planUnits,
  type DanmakuFormat,
  type PlannerOptions,
} from "./download/planner.ts";
import type { ArtifactKind } from "./download/task.ts";
import type { AudioQualityName, ViewResult } from "./types.ts";
import {
  DEFAULT_ARTIFACTS,
  DEFAULT_AUDIO_QUALITY,
  DEFAULT_DOWNLOAD_DIR,
  DEFAULT_NAMING_TEMPLATE,
} from "./defaults.ts";

const USAGE = `shushu — B 站工具（叔叔）

用法：
  shushu search <关键词> [--type video|bangumi|cheese|user|live_user] [--page N]
  shushu info <bvid|av 号|ep|ss|完整 URL>
  shushu download <bvid|av 号|ep|ss|完整 URL>
          [--artifact audio|cover|subtitle|danmaku|json|nfo] [--page N]
          [--quality 64K|132K|192K|Dolby|HiRes] [--format xml|json]
          [--dir <下载目录>]
     省略 --artifact 时下载默认集合（audio/cover/subtitle/danmaku/json/nfo）。
`;

/** 从 argv 里取 `--key value` 的值；无则返回默认。 */
function flag(argv: string[], key: string, fallback: string): string {
  const index = argv.indexOf(key);
  if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1];
  return fallback;
}

/** 非 `--` 开头的首个位置参数。 */
function positional(argv: string[]): string | undefined {
  return argv.find((arg) => !arg.startsWith("--"));
}

/** 搜索结果显示。 */
function renderSearch(result: {
  type: string;
  page: number;
  total: number;
  results: Array<{ kind: string; bvid?: string; title: string; author?: string; duration?: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`搜索（${result.type}）第 ${result.page} 页，共 ${result.total} 条：`);
  result.results.forEach((item, index) => {
    const id = item.bvid ?? `#${index}`;
    lines.push(
      `  ${index + 1}. [${item.kind}] ${item.title}` +
        (item.author !== undefined ? ` — ${item.author}` : "") +
        (item.duration !== undefined ? `（${item.duration}）` : "") +
        `\n     ${id}`,
    );
  });
  return lines.join("\n");
}

/** 视频信息显示（ViewResult 是判别联合）。 */
function renderView(view: ViewResult): string {
  const lines: string[] = [];
  if (view.kind === "video") {
    const info = view.info;
    lines.push(info.title);
    lines.push(`  bvid: ${info.bvid}  aid: ${info.aid}`);
    lines.push(`  时长: ${info.duration}s  UP: ${info.owner?.name ?? "?"}`);
    if (info.pages.length > 1) {
      lines.push(`  分P: ${info.pages.length} 个`);
      info.pages.forEach((p) => {
        lines.push(`    ${p.page}. ${p.part}（${p.duration}s）`);
      });
    } else if (info.pages.length === 1) {
      lines.push(
        `  分P: ${info.pages[0]?.part ?? "-"}（${info.pages[0]?.duration ?? 0}s）`,
      );
    }
    if (info.desc.length > 0) lines.push(`  简介: ${info.desc.slice(0, 120)}`);
  } else if (view.kind === "bangumi" || view.kind === "cheese") {
    const info = view.info as { title?: string; season_title?: string };
    lines.push(info.title ?? info.season_title ?? "");
    lines.push(`  类型: ${view.kind}`);
    if (view.ep !== null && view.ep !== undefined) {
      const ep = view.ep as { title?: string; long_title?: string; bvid?: string; id?: number };
      lines.push(
        `  集: ${ep.title ?? ""}${ep.long_title !== undefined ? `（${ep.long_title}）` : ""}`,
      );
    }
  } else {
    const info = view.info as { title?: string };
    lines.push(info.title ?? "");
    lines.push(`  类型: user`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === undefined || cmd === "--help" || cmd === "help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const client = new BiliClient();

  if (cmd === "search") {
    const query = positional(argv.slice(1));
    if (query === undefined) {
      process.stderr.write("用法：shushu search <关键词>\n");
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
    if (target === undefined) {
      process.stderr.write("用法：shushu info <bvid|av|ep|ss|URL>\n");
      process.exitCode = 1;
      return;
    }
    const view = await client.view(target);
    process.stdout.write(renderView(view) + "\n");
    return;
  }

  if (cmd === "download") {
    const target = positional(argv.slice(1));
    if (target === undefined) {
      process.stderr.write("用法：shushu download <bvid|av|ep|ss|URL>\n");
      process.exitCode = 1;
      return;
    }
    const rest = argv.slice(1);
    const artifact = flag(rest, "--artifact", "");
    const artifacts: ArtifactKind[] =
      artifact.length > 0
        ? ([artifact] as ArtifactKind[])
        : ([...DEFAULT_ARTIFACTS] as ArtifactKind[]);
    const pageText = flag(rest, "--page", "");
    const page = pageText.length > 0 ? Number.parseInt(pageText, 10) : undefined;
    const quality = flag(rest, "--quality", DEFAULT_AUDIO_QUALITY) as AudioQualityName;
    const format = flag(rest, "--format", "xml") as DanmakuFormat;
    const downloadDir = flag(rest, "--dir", DEFAULT_DOWNLOAD_DIR);

    const view = await client.view(target);
    const units = planUnits(view, page);
    const opts: PlannerOptions = {
      downloadDir,
      namingTemplate: DEFAULT_NAMING_TEMPLATE,
      audioQuality: quality,
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
    // 前台等待全部下载完成。
    await Promise.all(tasks.map((task) => task.settled));
    for (const task of tasks) {
      const mark = task.state === "done" ? "✓" : "✗";
      process.stdout.write(`${mark} ${task.title}\n   ${task.targetPath}\n`);
    }
    return;
  }

  process.stderr.write(`未知命令：${cmd}\n\n${USAGE}\n`);
  process.exitCode = 1;
}

void main();
