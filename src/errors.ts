/**
 * B 站错误码 → 模型友好文案（设计文档 §6）。
 * 工具 execute 抛错与下载任务 error 字段都走这里，避免原始 code/message 直接进模型上下文。
 */

import { BiliError } from "./http.ts";

/** 已知 B 站错误码的友好说明。 */
const CODE_HINTS: Record<number, string> = {
  [-101]: "未登录：该接口需要登录态（配置 sessdata 后可重试）",
  [-104]: "没有权限访问该内容（可能需要登录或为付费/私密内容）",
  [-352]: "触发风控：请求过于频繁，请稍后重试或放慢频率",
  [-400]: "请求参数错误",
  [-404]: "目标不存在或已失效",
  [-412]: "请求被拒绝（可能被风控拦截）",
};

/** 把任意错误转成模型友好文案；BiliError 优先映射已知错误码。 */
export function friendlyBiliError(error: unknown): string {
  if (error instanceof BiliError) {
    const hint = CODE_HINTS[error.code];
    return hint !== undefined ? `${hint}（code ${error.code}）` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
