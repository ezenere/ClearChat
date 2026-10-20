// Testes unitários (sem Electron, sem rede): extração do conteúdo principal do browse_url
// (tools/pageExtract.ts) com páginas salvas em e2e/fixtures/pages/.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractPage, formatExtracted } from '../src/main/tools/pageExtract.ts'

const page = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures/pages', name), 'utf8')

const DOCS_URL = 'https://docs.acme.dev/docs/v2/http-client'

test('docs/artigo: <main> com títulos, código, tabela, links absolutos; sem nav/sidebar/rodapé/cookies/ocultos', () => {
  const p = extractPage(page('docs-article.html'), DOCS_URL)
  const md = p.markdown
  assert.equal(p.strategy, 'main')
  assert.equal(p.via, '<main>')
  assert.equal(p.title, 'Configurando o cliente HTTP | Acme Docs')
  assert.equal(
    p.description,
    'Como configurar timeouts, retries e proxies no cliente HTTP da Acme.'
  )
  assert.equal(p.published, '2025-03-14T10:00:00Z')
  assert.equal(p.modified, '2025-06-02T08:30:00Z')
  assert.equal(p.canonical, DOCS_URL) // relativa, resolvida
  // conteúdo
  assert.match(md, /^# Configurando o cliente HTTP$/m)
  assert.match(md, /^## Instalação$/m)
  assert.match(md, /^### Glossário$/m)
  assert.match(md, /```bash\nnpm install @acme\/http --save\n# ou\npnpm add @acme\/http\n```/)
  assert.match(
    md,
    /```ts\nimport \{ HttpClient \} from '@acme\/http'\n\nconst client = new HttpClient\(\{\n {2}baseUrl/
  )
  assert.match(md, /\| Opção \| Tipo \| Padrão \| Descrição \|\n\|---\|---\|---\|---\|/)
  assert.match(md, /\| `timeout` \| number \| 30000 \| Tempo máximo de uma requisição\. \|/)
  assert.match(
    md,
    /\| `maxSockets` \| number \| 64 \| Conexões simultâneas por host \\\| pool\. \|/
  )
  assert.match(md, /\[tratamento de erros\]\(https:\/\/docs\.acme\.dev\/docs\/v2\/errors#retries\)/)
  assert.match(md, /\[RFC 9110\]\(https:\/\/example\.org\/rfc\/9110\)/)
  assert.match(md, /\[@acme\/socks\]\(https:\/\/docs\.acme\.dev\/docs\/v2\/socks\)/)
  assert.match(md, /> \*\*Atenção:\*\* nunca desative a verificação de TLS em produção\./)
  assert.match(md, /- \*\*Backoff\*\*: Intervalo crescente entre tentativas\./)
  assert.match(md, /\[imagem: Diagrama do fluxo de retry\]/)
  assert.match(
    md,
    /1\. Defina `HTTPS_PROXY` no ambiente, ou\n2\. passe .*\n {3}- autenticação básica/
  )
  assert.match(md, /\*\*retries com backoff exponencial\*\*/)
  // boilerplate fora
  for (const junk of [
    'Item lateral Alfa',
    'Produtos',
    'Usamos cookies',
    'RODAPE-DO-SITE',
    'Nesta página',
    'Pular para o conteúdo',
    'SEGREDO-OCULTO',
    'TEXTO-ESCONDIDO-INLINE',
    'ÍCONE-DECORATIVO',
    'Compartilhar no Twitter',
    'Editar esta página',
    'dataLayer',
    'Ative o JavaScript',
    'font-family'
  ])
    assert.ok(!md.includes(junk), `não devia ter "${junk}"`)
  assert.ok(p.contentChars < p.pageChars)
})

test('docs/artigo: mode "full" inclui menus e navegação (sem scripts nem ocultos); links=true lista os links', () => {
  const p = extractPage(page('docs-article.html'), DOCS_URL, { mode: 'full', links: true })
  assert.equal(p.strategy, 'full')
  assert.match(
    p.markdown,
    /\[Item lateral Alfa: Introdução\]\(https:\/\/docs\.acme\.dev\/docs\/v2\/intro\)/
  )
  assert.match(p.markdown, /\[Produtos\]\(https:\/\/docs\.acme\.dev\/produtos\)/)
  assert.match(p.markdown, /RODAPE-DO-SITE/)
  assert.match(p.markdown, /```ts/)
  assert.ok(!p.markdown.includes('SEGREDO-OCULTO'))
  assert.ok(!p.markdown.includes('dataLayer'))
  assert.ok(p.links!.some((l) => l.href === 'https://docs.acme.dev/precos' && l.text === 'Preços'))
  assert.ok(
    !p.links!.some((l) => l.href.includes('#instalacao')),
    'âncoras da própria página ficam de fora'
  )
  const out = formatExtracted(p)
  assert.match(out, /\[página inteira \(mode="full"\), menus e rodapé inclusos/)
  assert.match(out, /\n## Links da página\n- \[/)
  // padrão: links=false → sem a seção
  assert.ok(
    !formatExtracted(extractPage(page('docs-article.html'), DOCS_URL)).includes(
      '## Links da página'
    )
  )
})

test('preços: tabelas em Markdown com números, rowspan repetido e colspan; sem menu/newsletter/rodapé', () => {
  const p = extractPage(page('pricing.html'), 'https://nuvem.example/precos')
  const md = p.markdown
  assert.equal(p.strategy, 'main')
  assert.match(md, /^# Planos e preços$/m)
  assert.match(md, /\*\*Planos disponíveis\*\*/)
  assert.match(md, /\| Plano \| Preço mensal \| Usuários \| Armazenamento \| Suporte \|/)
  assert.match(md, /\| Básico \| R\$ 49,90 \| até 5 \| 100 GB \| E-mail \(48 h\) \|/)
  assert.match(md, /\| Pro \| R\$ 149,90 \| até 25 \| 1\.000 GB \| E-mail \(48 h\) \|/) // rowspan
  assert.match(
    md,
    /\| Empresa \| Sob consulta — a partir de R\$ 1\.290,00 \| {2}\| {2}\| Dedicado 24×7 \|/
  ) // colspan
  assert.match(md, /\| Requisições\/min \| 600 \| 6\.000 \| 60\.000 \|/)
  assert.match(md, /\| SLA \| 99,5% \| 99,9% \| 99,99% \|/)
  assert.match(md, /\*\*Posso trocar de plano depois\?\*\*/)
  assert.match(md, /Existe período de teste gratuito para o plano Pro\?/) // botão de acordeão com texto
  assert.match(md, /14 dias sem cartão de crédito/)
  for (const junk of ['Fale com vendas', 'newsletter', 'RODAPE-PRECOS', 'Assinar'])
    assert.ok(!md.includes(junk), `não devia ter "${junk}"`)
})

test('produto: JSON-LD (preço, marca, nota) compacto, canônica, título e preço da página mantidos', () => {
  const p = extractPage(page('product-jsonld.html'), 'https://loja.example/p/aurora-x2?ref=busca')
  assert.equal(p.title, 'Fone Bluetooth Aurora X2 | Loja Sonora')
  assert.equal(p.canonical, 'https://loja.example/p/aurora-x2')
  assert.equal(p.description, 'Cancelamento de ruído ativo, 40 h de bateria.')
  assert.deepEqual(p.structured, [
    'Product: "Fone Bluetooth Aurora X2" · preço 1299.00 BRL (em estoque) · marca Sonora · sku AUR-X2-PRT · nota 4.6/5 (312 avaliações)'
  ])
  const md = p.markdown
  assert.match(md, /^# Fone Bluetooth Aurora X2$/m)
  assert.match(md, /R\$ 1\.299,00 ou 10× de R\$ 129,90 sem juros/)
  assert.match(md, /drivers de 40 mm/)
  assert.match(md, /- \*\*Peso\*\*: 254 g/)
  assert.match(md, /- \*\*Bluetooth\*\*: 5\.3/)
  for (const junk of [
    'Quem viu também comprou',
    'Brisa Buds',
    'ofertas exclusivas',
    'RODAPE-LOJA',
    'Carrinho (0)',
    'Adicionar ao carrinho'
  ])
    assert.ok(!md.includes(junk), `não devia ter "${junk}"`)
  const out = formatExtracted(p)
  assert.match(
    out,
    /^# Fone Bluetooth Aurora X2 \| Loja Sonora\nURL: https:\/\/loja\.example\/p\/aurora-x2\?ref=busca\nCanônica: https:\/\/loja\.example\/p\/aurora-x2\n/
  )
  assert.match(
    out,
    /\nDados estruturados:\n- Product: "Fone Bluetooth Aurora X2" · preço 1299\.00 BRL/
  )
})

test('lista com pouca prosa: todos os itens, links resolvidos pelo <base>, tabela pequena; sem menus', () => {
  const p = extractPage(page('list-heavy.html'), 'https://lista.example.com/terminal/cli')
  const md = p.markdown
  assert.equal(p.strategy, 'main')
  assert.match(
    md,
    /^1\. \[ripgrep\]\(https:\/\/github\.com\/BurntSushi\/ripgrep\) — busca recursiva/m
  )
  assert.match(
    md,
    /^30\. \[just\]\(https:\/\/github\.com\/casey\/just\) — executor de comandos tipo make\.$/m
  )
  assert.equal((md.match(/^\d+\. \[/gm) ?? []).length, 30)
  assert.match(md, /\| Ctrl\+R \| busca no histórico \|/)
  assert.match(
    md,
    /\[Como contribuir\]\(https:\/\/lista\.example\.com\/terminal\/contribuir\.html\)/
  )
  assert.match(md, /\[Licença CC0\]\(https:\/\/lista\.example\.com\/licenca\)/)
  for (const junk of ['Enviar uma lista', 'Listas de Rust', 'Populares'])
    assert.ok(!md.includes(junk), `não devia ter "${junk}"`)
})

test('fallback: <main> enganoso (só o hero) → página inteira sem menus, avisando', () => {
  const p = extractPage(page('fallback.html'), 'https://ourover.de/guia')
  assert.equal(p.strategy, 'fallback')
  assert.match(p.reason!, /<main> da página tem só \d+% do texto/)
  const md = p.markdown
  for (const keep of [
    'Bem-vindo a Ouro Verde',
    'fundada em 1891',
    '60 boxes',
    'R$ 84,50',
    'R$ 160'
  ])
    assert.ok(md.includes(keep), `devia ter "${keep}"`)
  assert.ok(!md.includes('Eventos'), 'menu continua fora')
  assert.ok(!md.includes('RODAPE-CIDADE'))
  assert.match(
    formatExtracted(p),
    /\[conteúdo principal não identificado com segurança \(o <main> da página tem só \d+% do texto\) — mostrando a página inteira sem menus/
  )
  // mode full: menu volta
  assert.ok(
    extractPage(page('fallback.html'), 'https://ourover.de/guia', {
      mode: 'full'
    }).markdown.includes('Eventos')
  )
})

test('ocultos: app inteiro aria-hidden (modal aberto) não some; hidden="until-found" fica; cabeçalho do artigo fica', () => {
  const prose = 'Texto importante do artigo que não pode sumir. '.repeat(60)
  const html = `<html><body>
    <div id="root" aria-hidden="true"><article><header><h1>Título real</h1><p>Por Ana</p></header><p>${prose}</p>
      <div hidden="until-found"><p>Resposta escondida até a busca.</p></div></article></div>
    <div role="dialog" class="modal"><p>Assine já!</p></div>
  </body></html>`
  const p = extractPage(html, 'https://ex.com/a')
  assert.match(p.markdown, /^# Título real$/m)
  assert.match(p.markdown, /Por Ana/)
  assert.match(p.markdown, /Texto importante do artigo/)
  assert.match(p.markdown, /Resposta escondida até a busca\./)
  assert.ok(!p.markdown.includes('Assine já'))
})

test('limpeza nunca devolve vazio: bloco de menu com quase todo o texto da página fica', () => {
  const html =
    '<html><body><nav><a href="/a">Apenas</a> <a href="/b">um menu</a></nav></body></html>'
  const p = extractPage(html, 'https://ex.com/')
  assert.match(p.markdown, /\[Apenas\]\(https:\/\/ex\.com\/a\) \[um menu\]\(https:\/\/ex\.com\/b\)/)
})

test('parágrafos longos são quebrados (read_file corta linhas > 2.000) sem perder texto', () => {
  const words = Array.from({ length: 900 }, (_, i) => `palavra${i}`).join(' ')
  const p = extractPage(`<html><body><main><p>${words}</p></main></body></html>`, 'https://ex.com/')
  assert.ok(p.markdown.split('\n').every((l) => l.length <= 900))
  assert.equal(p.markdown.replace(/\n/g, ' '), words)
})
