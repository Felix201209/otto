/**
 * 📝 路径工具函数
 */

/**
 * 截断长路径，保留首尾部分，中间用 ... 省略
 * @param filePath 完整文件路径
 * @param maxLength 最大显示长度（默认 60 字符）
 * @returns 截断后的路径
 *
 * @example
 * truncatePath('d:\\projects\\deepVCode\\otto-deepvlab-ai-web\\OTTO.md', 60)
 * // => 'd:\projects\...\otto-deepvlab-ai-web\OTTO.md'
 */
export function truncatePath(filePath: string, maxLength: number = 60): string {
  // 如果路径长度不超过 maxLength，直接返回
  if (filePath.length <= maxLength) {
    return filePath;
  }

  // 计算省略号的空间
  const ellipsis = '...';
  const ellipsisLength = ellipsis.length;

  // 保留的首尾长度（各占剩余空间的一半）
  const availableLength = maxLength - ellipsisLength;
  const startLength = Math.ceil(availableLength / 2);
  const endLength = Math.floor(availableLength / 2);

  // 提取首尾部分
  const start = filePath.slice(0, startLength);
  const end = filePath.slice(-endLength);

  return `${start}${ellipsis}${end}`;
}

/**
 * 获取路径的显示形式（智能截断 - 保留首尾 + 中间省略）
 * @param filePath 完整文件路径
 * @param maxLength 最大显示长度（默认 55 字符）
 * @returns 优化后的显示路径
 *
 * 策略：保留路径开头（如 d:\projects\）和结尾（如 \folder\file.md）
 * 中间用 ... 替代，确保首尾路径清晰可见
 *
 * 示例：
 * 输入：d:\projects\deepVCode\otto-deepvlab-ai-web\OTTO.md
 * 输出：d:\projects\...\otto-deepvlab-ai-web\OTTO.md
 */
export function getDisplayPath(filePath: string, maxLength: number = 55): string {
  // 如果路径长度不超过 maxLength，直接返回
  if (filePath.length <= maxLength) {
    return filePath;
  }

  const separator = filePath.includes('\\') ? '\\' : '/';
  const ellipsis = '...';
  const ellipsisWithSeparators = `${separator}${ellipsis}${separator}`;

  // 分割路径
  const parts = filePath.split(separator).filter(p => p.length > 0);

  if (parts.length <= 2) {
    // 路径太短了，直接用标准截断
    return truncatePath(filePath, maxLength);
  }

  // 优先保留：
  // - 起始部分（通常是盘符或根目录）
  // - 最后两个部分（父目录和文件名）
  const lastTwoParts = parts.slice(-2).join(separator);
  const availableForStart = maxLength - ellipsisWithSeparators.length - lastTwoParts.length;

  if (availableForStart <= 0) {
    // 空间不足，直接用标准截断
    return truncatePath(filePath, maxLength);
  }

  // 从前往后保留尽可能多的完整目录
  let startParts: string[] = [];
  let currentLength = 0;

  for (let i = 0; i < parts.length - 2; i++) {
    const part = parts[i];
    const partWithSeparator = i === 0 ? part : separator + part;

    if (currentLength + partWithSeparator.length <= availableForStart) {
      startParts.push(part);
      currentLength += partWithSeparator.length;
    } else {
      break;
    }
  }

  // 如果至少保留了一部分开头，就构建最终路径
  if (startParts.length > 0) {
    const startPath = startParts.join(separator);
    return `${startPath}${ellipsisWithSeparators}${lastTwoParts}`;
  }

  // 否则使用标准截断方式
  return truncatePath(filePath, maxLength);
}
