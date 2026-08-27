/** 视频能力模型名单（auto 判定用；匹配不到按无视频能力处理，宁错勿烧钱） */
const VIDEO_CAPABLE_PATTERNS: RegExp[] = [
  /qwen[\w.-]*vl/i,      // qwen-vl / qwen2.5-vl / qwen3-vl ...
  /gpt-4o/i,
  /gemini/i,             // gemini-1.5-flash / gemini-2.5-pro ...
  /glm-4v/i,
  /doubao.*vision/i,
];

export function isVideoCapableModel(model: string): boolean {
  return VIDEO_CAPABLE_PATTERNS.some((p) => p.test(model));
}
