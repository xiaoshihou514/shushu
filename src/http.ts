/**
 * B 站 API 请求封装：固定 UA/Referer、SESSDATA cookie、BiliResp 校验、
 * 瞬态重试与请求间隔限速。对应原版 `bili_client.rs` 的 client 部分。
 *
 * 全局 `fetch`（Node 22 自带）；代理暂不实现（见 docs/agent/bilibili-tool.md）。
 */

import type { BiliResp } from "./types.ts";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const REFERRER = "https://www.bilibili.com/";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_REQUEST_INTERVAL_MS = 200;
const BACKOFF_BASE_MS = 300;

export interface BiliHttpOptions {
  /** 登录态；留空则匿名请求。 */
  sessdata?: string;
  /** 瞬态错误（网络错误 / 5xx）重试次数，默认 3（对齐原版 max_retries=3）。 */
  retries?: number;
  /** 相邻请求最小间隔（ms），默认 200，风控友好。 */
  requestIntervalMs?: number;
  /** 单请求超时（ms），默认 30s。 */
  timeoutMs?: number;
}

/** B 站业务错误：`code !== 0` 时抛出，携带 B 站错误码与 message。 */
export class BiliError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`bilibili ${code}: ${message}`);
    this.name = "BiliError";
    this.code = code;
  }
}

/** 判断一个 HTTP 响应体是否可重试的瞬态状态码。 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * B 站 API 客户端。所有方法都返回 `BiliResp.data`（`code === 0`），
 * 否则抛 {@link BiliError}。
 */
export class BiliHttp {
  readonly sessdata: string;
  readonly retries: number;
  readonly requestIntervalMs: number;
  readonly timeoutMs: number;
  #lastRequestAt = 0;

  constructor(options: BiliHttpOptions = {}) {
    this.sessdata = options.sessdata ?? "";
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 生成带基础头的请求头：UA、Referer、可选 SESSDATA cookie。 */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      referer: REFERRER,
    };
    if (this.sessdata !== "") headers.cookie = `SESSDATA=${this.sessdata}`;
    return headers;
  }

  /** 请求间隔限速：保证相邻请求至少间隔 `requestIntervalMs`。 */
  private async pace(): Promise<void> {
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
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    let attempt = 0;
    while (true) {
      await this.pace();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          headers: { ...this.headers(), ...init.headers },
          signal: init.signal ?? controller.signal,
        });
        if (!isTransientStatus(response.status) || attempt >= this.retries) {
          return response;
        }
        // 瞬态状态码：释放响应体后退避重试
        await response.body?.cancel();
      } catch (error) {
        if (attempt >= this.retries) throw error;
        // 网络错误 / 超时（AbortError）属于瞬态，继续重试
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
  async getJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = /^https?:\/\//.test(path)
      ? new URL(path)
      : new URL(`https://api.bilibili.com${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== "") url.searchParams.set(key, value);
    }
    const response = await this.request(url.toString());
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new BiliError(response.status, `HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const body = (await response.json()) as BiliResp<T>;
    if (body.code !== 0) {
      throw new BiliError(body.code, body.message || "未知错误");
    }
    if (body.data === undefined) {
      throw new BiliError(body.code, "响应缺少 data 字段");
    }
    return body.data;
  }

  /** GET 一个任意 URL 的文本内容（如字幕 json、弹幕 XML）。 */
  async getText(url: string): Promise<string> {
    const response = await this.request(url);
    if (!response.ok) {
      throw new BiliError(response.status, `HTTP ${response.status}`);
    }
    return response.text();
  }

  /** GET 一个任意 URL 的二进制内容（如音频流、封面）。 */
  async getArrayBuffer(url: string): Promise<ArrayBuffer> {
    const response = await this.request(url);
    if (!response.ok) {
      throw new BiliError(response.status, `HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  }
}
