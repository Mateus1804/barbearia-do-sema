# Registro de auditoria técnica

**Projeto:** Barbearia do Semá  
**Data:** 21/10/2026  
**Referência de entrada:** `f319fd9cccdcfb35bb28ae5844ad0a27caba9882`  
**Ambiente:** Linux, Node.js 24.19.0, npm 11.9.0, Chromium 141.0.7390.37 pelo Playwright do projeto.

## Escopo e método

Foram revisados servidor, interface, regras compartilhadas, configuração, persistência, lembretes, testes e documentação. A inspeção abrangeu contratos HTTP, validação, autorização, SQL, transações, horários, renderização HTML, erros e respostas assíncronas.

O trabalho foi realizado em branch própria, com a referência inicial preservada para comparação. Foram usados bancos isolados e transporte SMTP simulado. A stack, as rotas existentes, os campos da API e a identidade visual foram mantidos.

Os achados distinguem falhas reproduzidas, organização e medidas de defesa. A validação interna inclui testes e revisão do diff; não houve revisão humana independente registrada neste trabalho.

## Achados comprovados

| ID | Prioridade | Arquivo e ponto | Evidência e impacto | Correção |
|---|---|---|---|---|
| A01 | Alta | `public/js/customer.js`, `saveEditAppointment` | O listener de submit está no contêiner. Tratar `event.currentTarget` como formulário deixava o ID indefinido e enviava a alteração para `/api/appointments/undefined`. O teste de fluxo reproduziu a falha. | Localizar o formulário em `event.target.closest('form[data-edit-form]')` e conferir sua presença. |
| A02 | Média | `public/js/admin.js`, `loadAdminAppointments`; `public/js/availability.js`, `loadAvailableSlots` | Respostas antigas substituíam horários e períodos escolhidos depois. Dois testes controlaram a ordem de entrega e reproduziram o problema. | Identificar a geração da consulta e sua sessão, descartando resultados e erros obsoletos. Compartilhar a consulta de disponibilidade entre cliente e painel. |
| A03 | Média | `src/routes/admin.js`, listagem da agenda | O período era conferido pelo formato, sem validar o calendário. Datas como 30 de fevereiro passavam. | Validar ambas as datas com `ensureCalendarDate`; datas inexistentes recebem HTTP 400. |
| A04 | Média | `src/reminders.js`, `sendDueReminder` e `dispatchDueReminders` | Uma fotografia da agenda e um único horário inicial permitiam envio após cancelamento de outra reserva, marcação de uma nova programação e envio fora da janela. Os três casos foram reproduzidos com transporte suspenso ou relógio controlado. | Reler cada reserva, consultar o relógio atual e condicionar a marcação à programação, ao instante e ao status enviados. |
| A05 | Alta | `src/database.js`, migração de `confirmation_code` | Um banco sintético com campo legado e colunas posteriores perdeu marcas de envio, WhatsApp e programação original na reconstrução. | Preservar campos existentes, preencher somente os ausentes e manter a sequência de IDs. |
| A06 | Baixa | Testes de navegador e `test-support/browser.js` | A decisão de pular testes ocorria antes do hook de inicialização. Sem Chromium, a primeira execução teve 45 aprovações e 30 falhas por navegador indefinido. | Verificar a disponibilidade durante cada teste e oferecer modo obrigatório com `REQUIRE_BROWSER_TESTS=1`. |
| A07 | Baixa | `README.md` | A documentação exigia telefone e e-mail juntos e orientava excluir o lockfile para resolver instalação. | Documentar o contrato atual e a instalação reproduzível com `npm ci`, preservando o lockfile. |

Os três testes novos de interface falharam antes das correções e passaram depois. Os testes de banco e lembretes reproduziram A04/A05 antes de sua correção. A migração foi exercitada em fixtures: isso não afirma que houve perda de dados em uma instalação real.

## Organização e manutenção

| Alteração | Finalidade |
|---|---|
| `server.js` | Manter somente inicialização HTTP e temporizador |
| `src/config.js`, `src/database.js` | Isolar configuração, proteção de produção, esquema e compatibilidade |
| `src/calendar.js` | Centralizar calendário e conversões de fuso |
| `src/booking.js` | Reutilizar criação entre cliente e administrador e concentrar transações de alteração |
| `src/auth.js`, `src/routes/`, `src/http.js` | Separar autenticação, transporte HTTP e erros das regras de negócio |
| `src/reminders.js` | Permitir testes com relógio e transporte injetados |
| `public/js/` | Separar utilitários, disponibilidade, agendamento, cliente, administrador e animações |
| `public/booking-rules.js` | Compartilhar contatos, formulário e prazo de alteração entre servidor e navegador |
| ESLint | Distinguir ambientes e reprovar avisos, erros e execução dinâmica de código |

As exportações consumidas pelos testes foram preservadas. Seletores, classes CSS e animações dinâmicas foram mantidos. Não foram acrescentadas dependências ao projeto nem trocado o framework da interface.

## Defesa e consistência

- Política de conteúdo habilitada, com scripts da própria origem e domínios de fontes e imagens já usados. Estilos inline continuam permitidos para os estilos dinâmicos. É uma medida de defesa, sem alegação de exploração anterior.
- JWT explicitamente restrito ao HS256, já emitido no login. Os testes recusaram tokens expirados, com outra função, assinatura ou algoritmo.
- `Cache-Control: no-store` na API e no painel.
- JSON para rotas inexistentes, conteúdo excessivo e corpo malformado. Erros de parsing não reproduzem conteúdo recebido na mensagem pública.
- Transações de escrita imediatas para criação, remarcação, cancelamento e bloqueio.
- Valores fornecidos pelo cliente permanecem em consultas parametrizadas. Nomes interpolados de tabelas e colunas são constantes internas, sem escolha por parâmetros HTTP.
- Escapamento de HTML preservado. O teste de lembrete inclui um nome semelhante a uma tag HTML.
- A consulta ao registro de alertas do npm retornou zero vulnerabilidades conhecidas nas dependências de produção instaladas; não avalia infraestrutura, regras de negócio ou falhas ainda não catalogadas.

## Evidências de validação

| Verificação | Resultado |
|---|---|
| `npm ci` | Instalação concluída com o lockfile existente |
| Lint inicial | Aprovado |
| Suíte original após instalar Chromium | 75 aprovados, zero falhas e zero pulados |
| `npm run lint` final | Zero erros e zero avisos |
| `REQUIRE_BROWSER_TESTS=1 npm test` final | 98 aprovados, zero falhas, zero cancelados e zero pulados |
| `npm audit --omit=dev` | Zero alertas conhecidos na consulta realizada |
| Navegador ausente em execução específica de três testes | Três explicitamente pulados, zero falhas |
| Navegador ausente com modo obrigatório | Três falhas explícitas, zero testes pulados, conforme esperado |
| Inicialização com `NODE_ENV=production` e credenciais de teste | HTTP, health check, HTML e oito recursos JavaScript aprovados; banco em memória e SMTP desativado |
| Bancos atuais e legados de teste | Dados comparados, `integrity_check` aprovado e `foreign_key_check` sem ocorrências |
| E-mail | Transporte simulado, sem mensagens reais |
| Capturas original/revisada | Zero pixels diferentes nos três tamanhos |
| `git diff --check` | Aprovado |

Os 23 cenários adicionais cobrem fluxo de remarcação e cancelamento por um identificador, respostas administrativas fora de ordem, datas inexistentes, limite exato de duas horas, migração, lembretes e segurança. Os testes existentes de layout permanecem ativos.

### Condições da comparação visual

Páginas completas foram capturadas em viewports de 1280×900, 768×1024 e 390×844. As alturas resultantes foram 4917, 6581 e 6923 pixels. Não houve erros JavaScript nas seis capturas.

Fontes e fotografias externas foram bloqueadas nas duas versões, e animações e transições foram estabilizadas. Cada par foi idêntico nessas condições. A suíte de layout também verificou animações ativas, centralização e ausência de rolagem lateral. A comparação não representa inspeção de recursos externos carregados em produção.

## Limites e riscos remanescentes

| Item | Situação |
|---|---|
| Telefone ou e-mail | O requisito não comprova posse do identificador. Conhecer um dos dados pode permitir acesso às reservas associadas. Uma garantia maior de identidade depende de decisão de produto, como confirmação de posse. |
| Mais de uma instância | O bloqueio dos ciclos é local ao processo; múltiplas instâncias podem duplicar e-mails. |
| Envio em andamento | Uma mensagem aceita pelo SMTP não pode ser recolhida caso a reserva mude durante o envio. |
| Falha entre SMTP e SQLite | Uma parada após aceitação e antes da marcação pode permitir repetição. Não há garantia de entrega exatamente uma vez. |
| Janela dos lembretes | Paradas superiores a 15 minutos podem perder envios. |
| SMTP real | Credenciais e entrega do provedor não foram verificadas; o transporte foi simulado. |
| Dados hospedados | Bancos de produção e backups reais não foram acessados. As migrações foram testadas em memória e arquivos temporários. |
| Infraestrutura | HTTPS, volume, retenção e backup dependem da hospedagem. A aplicação considera um proxy confiável. |
| Runtime | O requisito continua Node.js 22 ou superior. Esta execução verificou Node.js 24.19.0, sem execução separada em Node.js 22 ou Windows. |
| Recursos externos | Fontes e fotografias dependem dos serviços já utilizados. |
| Integração | Preparado para revisão por pull request; merge e publicação não fazem parte desta execução. |

## Reprodução

```bash
npm ci
npx playwright install chromium
npm run lint
REQUIRE_BROWSER_TESTS=1 npm test
npm audit --omit=dev
git diff --check
```

No PowerShell, defina `$env:REQUIRE_BROWSER_TESTS = "1"` antes de `npm test`. Reavalie os resultados quando código, dependências, navegador ou ambiente forem alterados.
