/**
 * 下载任务管理器：任务注册表 + 并发调度（队列/活跃计数）+ 历史持久化。
 * 对应原版 `download_manager.rs` 的角色，但去掉分片信号量（单流下载）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DownloadTask, type TerminalRecord } from "./task.ts";

/** 历史记录上限（防止文件无限膨胀）。 */
const HISTORY_LIMIT = 200;

export interface DownloadManagerOptions {
  /** 同时活跃的下载任务数。 */
  concurrency: number;
  /** 历史记录文件路径；省略则不持久化。 */
  historyPath?: string;
}

/** 下载任务管理器。 */
export class DownloadManager {
  readonly concurrency: number;
  readonly historyPath: string | undefined;
  #tasks = new Map<string, DownloadTask>();
  #queue: DownloadTask[] = [];
  #active = 0;
  #history: TerminalRecord[] = [];

  constructor(options: DownloadManagerOptions) {
    this.concurrency = options.concurrency;
    this.historyPath = options.historyPath;
    if (this.historyPath !== undefined) {
      void this.#loadHistory();
    }
  }

  /** 从磁盘恢复历史记录（失败静默——历史只是展示用途）。 */
  async #loadHistory(): Promise<void> {
    if (this.historyPath === undefined) return;
    try {
      const content = await readFile(this.historyPath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        this.#history = parsed.filter(
          (item): item is TerminalRecord => typeof item === "object" && item !== null && "id" in item,
        );
      }
    } catch {
      // 文件不存在或损坏：视为空历史
    }
  }

  /** 入队一个任务并尝试启动。 */
  enqueue(task: DownloadTask): void {
    this.#tasks.set(task.id, task);
    this.#queue.push(task);
    this.pump();
  }

  /** 全部任务（含排队/进行中/已终态未删除）。 */
  list(): DownloadTask[] {
    return [...this.#tasks.values()];
  }

  /** 按 id 取任务。 */
  get(id: string): DownloadTask | undefined {
    return this.#tasks.get(id);
  }

  /** 取消任务（进行中中止下载；排队中直接取消）。返回是否找到。 */
  cancel(id: string): boolean {
    const task = this.#tasks.get(id);
    if (task === undefined) return false;
    task.cancel();
    return true;
  }

  /** 删除任务（取消并从注册表移除；终态任务已入历史）。返回是否找到。 */
  remove(id: string): boolean {
    const task = this.#tasks.get(id);
    if (task === undefined) return false;
    task.cancel();
    this.#tasks.delete(id);
    const queueIndex = this.#queue.indexOf(task);
    if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
    return true;
  }

  /** 历史记录（最近的在前；含本次会话的终态任务与磁盘恢复的记录）。 */
  history(): TerminalRecord[] {
    return this.#history;
  }

  /** 调度：活跃数不足时依次启动排队中的任务。 */
  private pump(): void {
    while (this.#active < this.concurrency) {
      const index = this.#queue.findIndex((task) => task.state === "queued");
      if (index < 0) break;
      const [task] = this.#queue.splice(index, 1);
      if (task === undefined) break;
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
  #record(task: DownloadTask): void {
    const record = task.toTerminalRecord();
    if (record === undefined) return;
    this.#history.unshift(record);
    if (this.#history.length > HISTORY_LIMIT) {
      this.#history.length = HISTORY_LIMIT;
    }
    const historyPath = this.historyPath;
    if (historyPath === undefined) return;
    void (async () => {
      try {
        await mkdir(dirname(historyPath), { recursive: true });
        await writeFile(historyPath, JSON.stringify(this.#history, null, 2), "utf8");
      } catch {
        // 历史落盘失败不影响下载本身
      }
    })();
  }
}
