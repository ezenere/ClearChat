# CLAUDE.md — ClearChat (app)

> ⚠️ **AVISO — PROTOCOLO DE SYNC COMPARTILHADO COM O SERVIDOR**
> Estes dois projetos (**ClearChat** app ↔ **ClearChatWebsite** servidor/site, em `../ClearChatWebsite`)
> compartilham o protocolo de sync em `docs/SYNC_PROTOCOL.md` (e `docs/test-vectors/`). Qualquer mudança no
> protocolo, na criptografia, nos esquemas dos registros, nos endpoints ou nas mensagens de WebSocket precisa
> ser feita **nos DOIS repositórios** (documentos idênticos, vetores regenerados, versão do protocolo
> incrementada + changelog). Mudar um lado só quebra o sync.

- Contrato do app: `SPEC.md` (lido antes de mudar qualquer coisa). Contrato do sync: `docs/SYNC_PROTOCOL.md`.
- Os esquemas de registro do sync (§4 do protocolo) espelham `src/shared/types.ts`, `memory.ts`, `skills.ts`,
  `presets.ts`, `webSearchSettings.ts` e as tabelas de `src/main/dbSchema.ts` / `src/main/memory/schema.ts`:
  mudou um desses dados → avaliar o impacto no protocolo (e nos dois repositórios).
- Vetores de cripto: `cd docs/test-vectors && npm install && node generate.ts --check` (o cliente de sync deve
  passar em todos). `docs/SYNC_PROTOCOL.md` e `docs/test-vectors/*.json` ficam fora do prettier (bytes idênticos).
- Commits sem trailer de co-autoria de IA.
