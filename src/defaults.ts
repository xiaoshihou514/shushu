import { homedir } from "node:os";
import { join } from "node:path";

/** 默认下载目录。 */
export const DEFAULT_DOWNLOAD_DIR = join(homedir(), "Downloads", "bilibili");
/** 默认命名模板（支持 {title}/{bvid}/{part}/{pubdate}/{up}）。 */
export const DEFAULT_NAMING_TEMPLATE = "{title}/{bvid}_{part}";
/** 默认音频质量。 */
export const DEFAULT_AUDIO_QUALITY = "192K" as const;
/** 不指定 --artifact 时的默认产物集合。 */
export const DEFAULT_ARTIFACTS = ["audio", "cover", "subtitle", "danmaku", "json", "nfo"] as const;
