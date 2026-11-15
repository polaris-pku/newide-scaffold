/**
 * 仅补全「无扩展名相对/绝对 specifier → .ts / index.ts」的 ESM resolve hook。
 *
 * 本仓源码（以及测试 fixture）使用 bundler 风格的无扩展名 import；Node 原生
 * TypeScript 变换要求显式扩展名。这个 hook 只做补全，不改变任何模块语义，
 * 供 `role-recovery-child-bootstrap.mjs` 在没有 tsx/esbuild 的环境里加载 worker。
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isPathLike =
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('file:') ||
      /^[A-Za-z]:[\\/]/.test(specifier);
    if (isPathLike) {
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {
          // 继续尝试下一个候选；全部失败时抛原始错误。
        }
      }
    }
    throw error;
  }
}
