/**
 * 登录态与 WBI keys：`/x/web-interface/nav`。
 */

import type { BiliHttp } from "../http.ts";
import type { WbiKeys } from "../wbi.ts";

/** nav 响应中我们关心的字段。 */
interface NavData {
  isLogin: boolean;
  mid?: number;
  uname?: string;
  wbiImg?: { imgUrl: string; subUrl: string };
}

/** 从 URL 中提取文件名（去扩展名），对应原版 `take_filename`。 */
export function takeFilename(url: string): string | undefined {
  const afterSlash = url.split("/").pop();
  if (afterSlash === undefined) return undefined;
  const dotIndex = afterSlash.lastIndexOf(".");
  if (dotIndex <= 0) return undefined;
  return afterSlash.slice(0, dotIndex);
}

/** 拉取登录态与 WBI keys。未登录或 keys 缺失时 `wbiImg` 为 undefined。 */
export async function fetchNav(http: BiliHttp): Promise<NavData> {
  const data = await http.getJson<{
    isLogin?: boolean;
    mid?: number;
    uname?: string;
    wbi_img?: { img_url: string; sub_url: string };
  }>("/x/web-interface/nav");
  const wbiImg =
    data.wbi_img !== undefined
      ? {
          imgUrl: data.wbi_img.img_url,
          subUrl: data.wbi_img.sub_url,
        }
      : undefined;
  const nav: NavData = {
    isLogin: data.isLogin ?? false,
    ...(data.mid !== undefined ? { mid: data.mid } : {}),
    ...(data.uname !== undefined ? { uname: data.uname } : {}),
    ...(wbiImg !== undefined ? { wbiImg } : {}),
  };
  return nav;
}

/** 从 nav 数据中提取 WBI keys（文件名部分），失败返回 undefined。 */
export function wbiKeysFromNav(nav: NavData): WbiKeys | undefined {
  if (nav.wbiImg === undefined) return undefined;
  const imgKey = takeFilename(nav.wbiImg.imgUrl);
  const subKey = takeFilename(nav.wbiImg.subUrl);
  if (imgKey === undefined || subKey === undefined) return undefined;
  return { imgKey, subKey };
}
