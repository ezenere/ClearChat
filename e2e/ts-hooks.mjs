// Hooks de resolução para rodar módulos TS puros do main direto no Node (type stripping nativo):
// `@shared/x` → src/shared/x.ts e imports relativos sem extensão → .ts.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@shared/')) {
      return next(
        pathToFileURL(resolve(root, 'src/shared', specifier.slice(8) + '.ts')).href,
        context
      )
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      context.parentURL?.endsWith('.ts')
    ) {
      const base = resolve(dirname(fileURLToPath(context.parentURL)), specifier)
      for (const cand of [base + '.ts', resolve(base, 'index.ts')]) {
        if (existsSync(cand)) return next(pathToFileURL(cand).href, context)
      }
    }
    return next(specifier, context)
  }
})
