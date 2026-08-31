# 叔叔我啊，最...

```bash
npm install -g shushu
```

```bash
# 搜索
shushu search <关键词> [--type video|bangumi|cheese|user|live_user] [--page N]

# 视频/番剧/课程信息
shushu info <bvid|av 号|ep|ss|完整 URL>

# 下载（省略 --artifact 时下载默认集合）
shushu download <bvid|av 号|ep|ss|完整 URL>
        [--artifact audio|cover|subtitle|danmaku|json|nfo]
        [--page N] [--quality 64K|132K|192K|Dolby|HiRes]
        [--format xml|json] [--dir <下载目录>]

shushu search "深度学习" --type video
shushu info BV1xx411c7mD
shushu download BV1xx411c7mD --artifact audio --quality 192K
```

## 产物说明

- `audio` — 音频（m4a / flac，按 `--quality` 选择最高可用档）
- `cover` — 封面图
- `subtitle` — 字幕（srt）
- `danmaku` — 弹幕（xml 或 json）
- `json` — 视频元数据
- `nfo` — 刮削用的 nfo 文件

默认下载目录为 `~/Downloads/bilibili`（可用 `--dir` 覆盖）

MIT
