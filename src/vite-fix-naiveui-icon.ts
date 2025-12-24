import type { Plugin, ResolvedConfig } from 'vite'
import type { Option } from './types'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import MagicString from 'magic-string'
import { createFilter } from 'vite'
import { transformDev, transformMap } from './transformMap'

const getVirtualPath = () => {
  let _dirname_: string
  try {
    _dirname_ = __dirname
  }
  catch {
    _dirname_ = dirname(fileURLToPath(import.meta.url))
  }
  return _dirname_.replace(/[/\\]dist$/, '/src/virtual')
}

/**
 * 比较版本号
 * @returns true 如果 version >= target
 */
function compareVersion(version: string, target: string): boolean {
  const v1 = version.split('.').map(Number)
  const v2 = target.split('.').map(Number)
  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const n1 = v1[i] || 0
    const n2 = v2[i] || 0
    if (n1 > n2)
      return true
    if (n1 < n2)
      return false
  }
  return true
}

/**
 * 获取 naive-ui 版本号
 */
function getNaiveUIVersion(root: string): string | null {
  try {
    // 尝试使用 createRequire 来解析 naive-ui 的 package.json
    const require = createRequire(root.endsWith('/') ? root : `${root}/`)
    const pkgPath = require.resolve('naive-ui/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version
  }
  catch {
    // 如果解析失败，返回 null
    return null
  }
}

// naive-ui >= 2.40.4 已修复内存泄漏问题
const FIXED_VERSION = '2.40.4'

const ViteFixNaiveuiIcon = ({ apply }: Option): Plugin[] => {
  const VirtualPath = getVirtualPath()
  let isBuild = false
  let skipFix = false
  let fixReplaceableFilter: (id: string | unknown) => boolean
  let fixExportDefaultFilter: (id: string | unknown) => boolean
  return [
    {
      name: 'vite-fix-naiveui-icon:pre',
      apply,
      enforce: 'pre',
      configResolved(config: ResolvedConfig) {
        // 检查 naive-ui 版本，>= 2.40.4 已修复内存泄漏问题
        const version = getNaiveUIVersion(config.root)
        if (version && compareVersion(version, FIXED_VERSION)) {
          skipFix = true
          config.logger.info(`[vite-fix-naiveui-icon] naive-ui@${version} >= ${FIXED_VERSION}, skip fix`)
        }
      },
      config(_, { command }) {
        if (command === 'build') {
          isBuild = true
          fixReplaceableFilter = createFilter(/\/naive-ui\/es\/_internal\/icons\/replaceable/)
          fixExportDefaultFilter = createFilter([
            /\/naive-ui\/es\/checkbox\/src\/Checkbox\.mjs/,
            /\/naive-ui\/es\/back-top\/src\/BackTop\.mjs/,
            /\/naive-ui\/es\/rate\/src\/Rate\.mjs/,
            /\/naive-ui\/es\/result\/src\/Result\.mjs/,
          ])
        }
        else {
          isBuild = false
          fixReplaceableFilter = createFilter(/\/\.vite\/deps\/naive-ui\.js/)
          fixExportDefaultFilter = createFilter(/\/\.vite\/deps\/naive-ui\.js/)
        }
      },
      resolveId(id) {
        if (id.startsWith('virtual:fixNaiveuiIcon-path:')) {
          return id.replace('virtual:fixNaiveuiIcon-path:', `${VirtualPath}/`)
        }
        return null
      },
      load(id) {
        if (id.startsWith(VirtualPath)) {
          if (existsSync(id))
            return readFileSync(id, 'utf-8')
        }
      },
      transform(code, id) {
        if (skipFix)
          return
        if (!fixReplaceableFilter(id) && !fixExportDefaultFilter(id))
          return
        const magicString = new MagicString(code)
        magicString.prepend(`import fixNaiveuiIconCloneVnode from 'virtual:fixNaiveuiIcon-path:deepCloneVnode.js';\n`)
        return {
          code: magicString.toString(),
          map: magicString.generateMap({ source: id, hires: true }),
        }
      },
    },
    {
      // 修复replaceable导致的内存泄漏
      name: 'vite-fix-naiveui-icon-replaceable',
      apply,
      enforce: 'post',
      transform(code, id) {
        if (skipFix)
          return
        if (!fixReplaceableFilter(id))
          return
        const magicString = new MagicString(code)
        magicString.replace(
          'function replaceable(name, icon)',
          'function replaceable(name, _icon_)',
        )
        // 匹配 replaceable 方法的定义范围
        const replaceableMatch = /function replaceable\s*\(([^,]+),\s*icon\)\s*\{/.exec(code)

        if (replaceableMatch) {
          const [fullMatch] = replaceableMatch
          const startIdx = replaceableMatch.index
          const endIdx = startIdx + fullMatch.length

          let braceCount = 1
          let funcEndIdx = endIdx

          while (braceCount > 0 && funcEndIdx < code.length) {
            const char = code[funcEndIdx]
            if (char === '{')
              braceCount++
            if (char === '}')
              braceCount--
            funcEndIdx++
          }

          const replaceableCode = code.slice(endIdx, funcEndIdx)
          const setupMatch = /setup\s*\(\)\s*\{/.exec(replaceableCode)
          if (setupMatch) {
            const setupStartIdx = endIdx + setupMatch.index + setupMatch[0].length

            magicString.appendLeft(setupStartIdx, `\n  const icon = fixNaiveuiIconCloneVnode(_icon_);`)
          }
        }
        return {
          code: magicString.toString(),
          map: magicString.generateMap({ source: id, hires: true }),
        }
      },
    },
    {
      // 修复 naive-ui内置icon 导出直接引用导致 内存泄漏
      name: 'vite-fix-naiveui-icon-export-default',
      apply,
      enforce: 'post',
      transform(code, id) {
        if (skipFix)
          return
        if (!fixExportDefaultFilter(id))
          return
        const magicString = new MagicString(code)
        if (!isBuild) {
          transformDev(magicString, code)
        }
        else {
          switch (true) {
            case id.includes('checkbox'):
              transformMap.checkbox(magicString, code, true)
              break
            case id.includes('back-top'):
              transformMap.backTop(magicString, code, true)
              break
            case id.includes('rate'):
              transformMap.rate(magicString, code, true)
              break
            case id.includes('result'):
              transformMap.result(magicString)
              break
          }
        }
        return {
          code: magicString.toString(),
          map: magicString.generateMap({ source: id, hires: true }),
        }
      },
    },
  ]
}

export default ViteFixNaiveuiIcon
