/**
 * 单流下载任务：状态机 + 流式写盘。产物是单个文件（音频/封面/字幕/弹幕/元信息），
 * 不需要分片并发与断点续传（见 docs/agent/bilibili-tool.md §2）。
 */

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";
import { friendlyBiliError } from "../errors.ts";
import { BiliError, type BiliHttp } from "../http.ts";

/** 可下载的产物类型。 */
export type ArtifactKind = "audio" | "cover" | "subtitle" | "danmaku" | "json" | "nfo";

/** 任务状态。 */
export type TaskState = "queued" | "downloading" | "done" | "error" | "canceled";

/** 任务执行体：下载一个产物到 `targetPath`。 */
export interface DownloadTaskInit {
  id: string;
  artifact: ArtifactKind;
  /** 展示名（标题）。 */
  title: string;
  /** 最终落盘路径（入队时确定，见 planner）。 */
  targetPath: string;
  /**
   * 执行下载。必须观察 `signal`（中止时抛错或尽快返回），
   * 并通过 `onProgress` 汇报进度。
   */
  run: (
    signal: AbortSignal,
    onProgress: (bytesDone: number, bytesTotal: number | undefined) => void,
  ) => Promise<void>;
}

/** 历史记录（持久化用），不含执行体。 */
export interface TerminalRecord {
  id: string;
  artifact: ArtifactKind;
  title: string;
  targetPath: string;
  state: Exclude<TaskState, "queued" | "downloading">;
  error?: string;
  createdAt: number;
  finishedAt: number;
  bytesDone?: number;
  bytesTotal?: number;
}

/**
 * 一个下载任务。`state` 生命周期：`queued → downloading → done | error | canceled`。
 * `settled` 在进入终态时 resolve，供 {@link DownloadManager} 调度使用。
 */
export class DownloadTask {
  readonly id: string;
  readonly artifact: ArtifactKind;
  readonly title: string;
  readonly targetPath: string;
  readonly createdAt = Date.now();
  state: TaskState = "queued";
  bytesDone = 0;
  bytesTotal: number | undefined;
  error: string | undefined;
  finishedAt: number | undefined;
  /** 终态时 resolve（done/error/canceled）。 */
  readonly settled: Promise<void>;
  #settle!: () => void;
  #run: DownloadTaskInit["run"];
  #controller: AbortController | undefined;

  constructor(init: DownloadTaskInit) {
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
  start(): void {
    if (this.state !== "queued") return;
    this.state = "downloading";
    const controller = new AbortController();
    this.#controller = controller;
    this.#run(controller.signal, (bytesDone, bytesTotal) => {
      this.bytesDone = bytesDone;
      this.bytesTotal = bytesTotal;
    })
      .then(() => {
        if (this.state === "downloading") {
          this.state = controller.signal.aborted ? "canceled" : "done";
          this.finishedAt = Date.now();
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          this.state = "canceled";
        } else {
          this.state = "error";
          this.error = errorMessage(error);
        }
        this.finishedAt = Date.now();
      })
      .finally(() => this.#settle());
  }

  /** 取消：中止进行中的下载；排队中的任务直接标记 canceled。 */
  cancel(): void {
    if (this.state === "queued") {
      this.state = "canceled";
      this.finishedAt = Date.now();
      this.#settle();
    } else if (this.state === "downloading") {
      this.#controller?.abort();
    }
  }

  /** 是否处于终态。 */
  get isTerminal(): boolean {
    return this.state === "done" || this.state === "error" || this.state === "canceled";
  }

  /** 转成可持久化的历史记录（仅终态）。 */
  toTerminalRecord(): TerminalRecord | undefined {
    if (this.state === "queued" || this.state === "downloading" || this.finishedAt === undefined) {
      return undefined;
    }
    const record: TerminalRecord = {
      id: this.id,
      artifact: this.artifact,
      title: this.title,
      targetPath: this.targetPath,
      state: this.state,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
    };
    if (this.error !== undefined) record.error = this.error;
    if (this.bytesDone > 0) record.bytesDone = this.bytesDone;
    if (this.bytesTotal !== undefined) record.bytesTotal = this.bytesTotal;
    return record;
  }
}

/** 把未知错误转成可展示的字符串（B 站错误码映射为友好文案）。 */
export function errorMessage(error: unknown): string {
  return friendlyBiliError(error);
}

/**
 * 流式下载 URL 到文件（web stream 管道 + 进度汇报）。
 * 供音频/封面等二进制产物使用。
 */
export async function downloadToFile(
  http: BiliHttp,
  url: string,
  targetPath: string,
  signal: AbortSignal,
  onProgress: (bytesDone: number, bytesTotal: number | undefined) => void,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const response = await http.request(url, { signal });
  if (!response.ok) {
    throw new BiliError(response.status, `HTTP ${response.status}`);
  }
  if (response.body === null) throw new Error("响应没有 body");
  const bytesTotal = Number(response.headers.get("content-length") ?? 0) || undefined;
  const file = createWriteStream(targetPath);
  let bytesDone = 0;
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw new Error("下载已取消");
      await writeChunk(file, chunk as Uint8Array);
      bytesDone += (chunk as Uint8Array).length;
      onProgress(bytesDone, bytesTotal);
    }
  } finally {
    file.end();
    await finished(file).catch(() => undefined);
  }
}

/** 带背压的单次写入。 */
function writeChunk(file: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    file.write(chunk, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
}

/** 把文本内容写入文件（字幕/弹幕/元信息等小产物）。 */
export async function writeTextFile(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}
