// Erros de campos dentro de uma CollapsibleSection (panel/fields.tsx): o campo inválido avisa a
// seção mais próxima, que fica aberta e marca o cabeçalho enquanto o erro existir.
import { createContext, useContext, useEffect, useId } from 'react'

export type ReportSectionError = (key: string, error: string | null) => void

export const SectionErrorContext = createContext<ReportSectionError | null>(null)

/** Reporta (ou limpa, com null) o erro deste campo à seção recolhível que o contém. */
export function useSectionError(error: string | null | undefined): void {
  const report = useContext(SectionErrorContext)
  const key = useId()
  const msg = error || null
  useEffect(() => {
    if (!report) return
    report(key, msg)
    return () => report(key, null)
  }, [report, key, msg])
}
