# Barbearia do Semá

Sistema de agendamento da Barbearia do Semá, em Itacolomi, Sabará/MG. Reúne apresentação da barbearia, reserva de horários, área do cliente, painel administrativo e lembretes por e-mail em um único serviço Node.js.

O projeto é um MVP acadêmico. Esta documentação descreve a implementação, a revisão técnica e a renovação da interface realizadas em 21/10/2026.

## Funcionalidades

- Serviços, preços e consulta de horários disponíveis.
- Agendamento com pré-cadastro automático de nome, telefone e e-mail.
- Consulta das reservas por **telefone ou e-mail**, preenchendo apenas um dos campos.
- Remarcação e cancelamento pelo cliente até duas horas antes do atendimento.
- Painel para criar reservas, pré-confirmar presença, cancelar, bloquear intervalos e fechar dias.
- Lembretes de 24 horas e três horas por SMTP, conforme antecedência e janela de envio.
- Interface responsiva com animações e suporte à preferência por movimento reduzido.
- Galeria de fotografias com ampliação e navegação por teclado.

## Interface e fotografias

A interface combina verde escuro, creme e dourado, títulos com serifa e ícones SVG. A página reúne apresentação, serviços, experiência, galeria, agendamento e localização. No celular, o menu recolhe após uma ação e um atalho de reserva aparece quando a abertura e o formulário estão fora da tela.

As quatro fotografias WebP ficam em `public/images/`, sem depender de um servidor externo para carregar. São imagens ilustrativas: não representam instalações, equipe, clientes ou resultados da barbearia. Autores, originais e licença estão na [página de créditos](public/creditos-fotografias.html), também acessível pelo site. Para usar fotos próprias, substitua os arquivos e atualize textos alternativos, legendas e créditos.

A galeria aceita cliques, setas e Escape. Os modais mantêm a navegação por Tab em seu conteúdo e devolvem o foco ao fechar. As fontes continuam usando Google Fonts, com alternativas locais quando o serviço estiver indisponível.

![Prévia da interface em desktop](docs/imagens/frontend-desktop.jpg)

O [registro da renovação do frontend](docs/frontend.md) reúne decisões, capturas e validação.

## Tecnologias e requisitos

| Componente | Tecnologia |
|---|---|
| Servidor e API | Node.js 22 ou superior e Express |
| Persistência | SQLite com `better-sqlite3` |
| Interface | HTML, CSS e JavaScript com módulos nativos do navegador |
| Acesso administrativo | bcrypt e JWT |
| E-mail | Nodemailer com SMTP |
| Qualidade | ESLint, testes nativos do Node.js e Playwright/Chromium |

É necessário ter npm instalado. A auditoria registrada foi executada com **Node.js 24.19.0**. O frontend não exige compilação nem framework.

## Instalação e execução

Instale as versões registradas no lockfile:

```bash
npm ci
```

Crie a configuração local. No Prompt de Comando do Windows:

```bat
copy .env.example .env
```

No Linux ou macOS:

```bash
cp .env.example .env
```

Edite o `.env`, configure as credenciais e execute:

```bash
npm run dev
```

Acesse [http://localhost:3000](http://localhost:3000). Para iniciar sem reinicialização automática, use `npm start`. O mesmo servidor entrega a interface e a API; abra o site pelo endereço HTTP para carregar os módulos JavaScript.

### Acesso administrativo

O exemplo local usa `sema@barbeariadosema.com.br` e a senha `Sema@2026!`. São valores públicos de demonstração. Configure credenciais próprias antes de publicar.

Em produção, o servidor exige `ADMIN_PASSWORD` com pelo menos 12 caracteres e `JWT_SECRET` com pelo menos 32, recusando os exemplos reconhecidos pelo código. O token expira em oito horas e é armazenado na sessão da aba. O e-mail e o hash da senha administrativa são sincronizados com as variáveis a cada inicialização.

## Configuração

| Variável | Finalidade |
|---|---|
| `PORT` | Porta HTTP; padrão `3000` |
| `NODE_ENV` | Use `production` na hospedagem para exigir credenciais próprias |
| `DB_PATH` | Caminho do SQLite; padrão `data/barbearia.db` |
| `ADMIN_EMAIL` | E-mail administrativo |
| `ADMIN_PASSWORD` | Senha administrativa; o banco armazena seu hash |
| `JWT_SECRET` | Segredo para assinatura e verificação dos tokens |
| `PUBLIC_URL` | Endereço público usado nos links dos lembretes |
| `SMTP_HOST` | Servidor de envio |
| `SMTP_PORT` | Porta SMTP; padrão `587` |
| `SMTP_SECURE` | `true` para TLS desde a conexão, normalmente na porta `465`; na porta `587`, use `false` com STARTTLS |
| `SMTP_USER` | Usuário SMTP |
| `SMTP_PASS` | Credencial SMTP |
| `EMAIL_FROM` | Remetente; usa `SMTP_USER` quando omitido |

O `.env.example` contém os campos de configuração. Mantenha o `.env` fora do controle de versão. `DB_PATH=:memory:` é destinado a testes e não persiste os dados.

## Regras da agenda

- Atendimento de segunda a sábado, das 09h às 19h30, com almoço entre 12h e 13h.
- Início dos serviços em intervalos de 30 minutos, respeitando duração real e fechamento.
- Reservas para hoje ou os próximos 30 dias, com antecedência mínima de dez minutos.
- Domingos, dias fechados e bloqueios ficam indisponíveis. Bloquear uma faixa ocupada é recusado.
- Reservas ativas e pré-confirmadas ocupam a agenda; cancelar libera a faixa.
- A criação verifica conflitos dentro de transação SQLite com reserva de escrita. Uma segunda reserva para a mesma faixa recebe HTTP `409`.
- Horários são interpretados em `America/Sao_Paulo`, com o instante correspondente salvo em UTC.
- Remarcar ou cancelar é permitido **exatamente duas horas antes**; faltando menos, a operação é recusada.
- A pré-confirmação de presença não retira o direito de cancelamento dentro do prazo.

### Identificação do cliente

A criação exige nome, telefone e e-mail. As regras de contato são compartilhadas entre servidor e navegador em `public/booking-rules.js`.

A consulta, remarcação e cancelamento aceitam **somente telefone ou somente e-mail**. Quando os dois são enviados, ambos devem corresponder ao cadastro e à reserva.

Esse fluxo não comprova posse do telefone ou e-mail: conhecer um dos identificadores pode permitir acesso às reservas associadas. Essa limitação está registrada na auditoria técnica.

## Lembretes por e-mail

Configure as variáveis SMTP para ativar o envio. Para Gmail, utilize uma senha de app conforme a configuração da conta. A reserva continua funcionando quando o SMTP está desativado.

O servidor verifica a agenda a cada minuto. O lembrete de 24 horas exige que a criação ou última remarcação tenha ocorrido com pelo menos 24 horas de antecedência; o de três horas exige pelo menos três horas. O envio ocorre a partir do instante previsto e antes de completar 15 minutos de atraso. Fora dessa janela, o lembrete não é enviado.

Antes de cada envio, a reserva é relida e sua elegibilidade é verificada com o relógio atual. A marca de envio é gravada apenas se a programação continuar sendo aquela usada no e-mail. Falhas de transporte mantêm o lembrete pendente para nova tentativa dentro da janela.

As marcas no SQLite evitam reenvios nos ciclos normais de uma instância. Uma parada maior que a janela pode perder lembretes. Uma falha após o SMTP aceitar a mensagem e antes da gravação no banco pode permitir duplicidade. Execute a rotina atual em **uma única instância**.

## Organização do código

| Arquivo ou diretório | Responsabilidade |
|---|---|
| `server.js` | Inicialização HTTP e temporizador dos lembretes |
| `src/app.js` | Montagem da aplicação e middlewares |
| `src/config.js` | Variáveis de ambiente e proteção de produção |
| `src/database.js` | Esquema, migrações e dados iniciais |
| `src/calendar.js` | Calendário e conversões de fuso |
| `src/booking.js` | Validação e operações de agenda |
| `src/auth.js` | Login e verificação de token administrativo |
| `src/routes/` | Rotas públicas e administrativas |
| `src/http.js` | Erros HTTP e execução de handlers |
| `src/reminders.js` | Elegibilidade, conteúdo e envio dos lembretes |
| `public/app.js` | Inicialização da interface |
| `public/js/` | Utilitários, disponibilidade, agendamento, cliente, administrador, navegação e animações |
| `public/js/gallery.js` | Ampliação e navegação da galeria |
| `public/images/` | Fotografias ilustrativas em WebP |
| `public/creditos-fotografias.html` | Autores, fontes e licença das fotografias |
| `public/booking-rules.js` | Contatos, pendências do formulário e prazo compartilhado de alteração |
| `test/` | Testes automatizados |
| `test-support/` | Apoio aos testes de navegador |

As factories permitem usar banco isolado, relógio controlado e transporte de e-mail simulado. As exportações antes consumidas pelos testes em `server.js` foram preservadas.

## API

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/health` | Saúde e fuso da aplicação |
| GET | `/api/services` | Serviços, preços e durações |
| GET | `/api/available-slots/:data/:service_id` | Horários disponíveis |
| POST | `/api/appointments` | Criar reserva |
| POST | `/api/authenticate` | Consultar por telefone ou e-mail |
| PUT | `/api/appointments/:id` | Remarcar reserva do cliente |
| DELETE | `/api/appointments/:id` | Cancelar reserva do cliente |
| POST | `/admin/login` | Obter token administrativo |
| GET | `/admin/available-slots/:data/:service_id` | Horários no painel |
| GET | `/admin/appointments?de=AAAA-MM-DD&ate=AAAA-MM-DD` | Agenda e bloqueios do período |
| POST | `/admin/appointments` | Criar reserva pelo painel |
| POST | `/admin/appointments/:id/confirm` | Pré-confirmar presença |
| POST | `/admin/appointments/:id/cancel` | Cancelar pelo painel |
| POST | `/admin/block-slots` | Bloquear intervalo |
| DELETE | `/admin/block-slots/:id` | Remover bloqueio |
| POST | `/admin/holidays` | Fechar dia |
| DELETE | `/admin/holidays/:id` | Reabrir dia |

As rotas administrativas, exceto login, exigem `Authorization: Bearer <token>`. Erros de entrada, autorização, conflito e rotas inexistentes retornam JSON. API e painel usam `Cache-Control: no-store`.

## Testes e análise estática

```bash
npm run lint
npx playwright install chromium
npm test
```

O lint trata variáveis sem uso, `var`, comparações não estritas e execução dinâmica de código como erros. Avisos também reprovam o comando. A configuração distingue Node.js, módulos do navegador e testes.

Sem Chromium, os testes de navegador são identificados como pulados. Para exigir todos eles no Linux ou macOS:

```bash
REQUIRE_BROWSER_TESTS=1 npm test
```

No PowerShell:

```powershell
$env:REQUIRE_BROWSER_TESTS = "1"
npm test
```

| Grupo | Cobertura |
|---|---|
| Regras e calendário | Contatos, pendências, fuso, antecedência e duração |
| API e ciclo de vida | Reserva, consulta, remarcação, cancelamento, conflitos, bloqueios e painel |
| Limite de alteração | Exatamente duas horas e um milissegundo após o limite |
| Navegador | Formulário, consulta por um identificador, remarcação e cancelamento completos, rede e respostas atrasadas |
| Layout | Desktop, tablet e celular; alinhamento, rolagem lateral e animações |
| Novo frontend | Imagens locais, ícones, galeria, foco, teclado, menu, atalho móvel e movimento reduzido |
| Migrações | Bancos atuais e legados, preservação de dados e integridade SQLite |
| Lembretes | Transporte simulado, repetição de ciclos, falhas, cancelamento, remarcação e janela |
| Segurança | Credenciais de produção, JWT, política de conteúdo, erros, cache e reservas concorrentes |

Os testes usam bancos em memória e arquivos temporários próprios. O transporte de e-mail é simulado; nenhuma mensagem real é enviada pelos testes.

## Auditoria técnica e qualidade

A revisão técnica de 21/10/2026 partiu da referência `f319fd9`. A suíte original passou com 75 testes após instalar o Chromium. A refatoração registrada no commit `1b7ed09`, anterior à renovação visual, obteve:

- **98 testes aprovados, zero falhas e zero testes pulados**, com navegador obrigatório.
- **ESLint aprovado sem erros ou avisos.**
- `npm audit --omit=dev`: **zero vulnerabilidades conhecidas** nas dependências de produção instaladas, na consulta realizada.
- Capturas original/revisada com **zero pixels diferentes** em desktop, tablet e celular, estabilizando animações e bloqueando recursos externos em ambas as versões.

Foram corrigidos o formulário de remarcação, respostas antigas no painel, períodos com datas inexistentes, perda de campos em migração legada e revalidação dos lembretes durante envios. Regras foram centralizadas, responsabilidades separadas e cabeçalhos e erros reforçados.

O [registro da auditoria técnica](docs/auditoria-tecnica.md) apresenta arquivos envolvidos, evidências, critérios de validação e riscos remanescentes. Os resultados correspondem aos cenários executados e não certificam ausência de falhas.

A renovação visual posterior manteve os 98 testes e acrescentou seis cenários de navegador: **104 aprovados, zero falhas e zero pulados**, com `REQUIRE_BROWSER_TESTS=1 npm test`. O `npm run lint` passou sem erros ou avisos. Foram conferidas larguras de 320, 390, 768 e 1440 pixels, sem rolagem lateral ou erros JavaScript nas capturas. As fotografias carregaram com serviços externos bloqueados. Essa etapa altera intencionalmente o layout; a comparação de pixels acima pertence somente à refatoração anterior.

## Ícones

Todos os ícones vêm do [Tabler Icons](https://tabler.io/icons) (licença MIT, © Paweł Kuna), copiados sem alteração para o sprite no início do `public/index.html`. Não desenhamos ícones à mão: para trocar um, copie o SVG do Tabler e mantenha o `id`.

| `id` no site | Tabler | Uso |
|---|---|---|
| `icon-scissors` | `scissors` | Corte de cabelo, marca, selo |
| `icon-razor` | `razor` | Barba |
| `icon-clipper` | `razor-electric` | Máquina de corte (destaque do hero) |
| `icon-eye` | `eye` | Sobrancelha |
| `icon-brush` | `brush` | Pintura capilar |
| `icon-calendar`, `icon-pin`, `icon-clock`, `icon-phone`, `icon-mail`, `icon-user` | `calendar-check`, `map-pin`, `clock`, `phone`, `mail`, `user` | Agendamento, localização, horários, contato |
| setas, chevrons, check, fechar, menu, expandir | `arrow-*`, `chevron-*`, `check`, `circle-check`, `x`, `menu-2`, `arrows-maximize` | Interface |
| `icon-tv`, `icon-snowflake`, `icon-bag`, `icon-child`, `icon-image`, `icon-lock` | `device-tv`, `snowflake`, `shopping-bag`, `mood-kid`, `photo`, `lock` | Comodidades, galeria, área restrita |

## Movimento e rolagem

`public/js/motion.js` e `public/motion.css` fazem o scrollytelling (revelações, parallax, barra de progresso, menu com a seção em foco). A rolagem é sempre a do navegador: o script só lê a posição e escreve variáveis CSS. Com `prefers-reduced-motion: reduce`, ou sem JavaScript, tudo aparece de imediato. Os testes estão em `test/motion.browser.test.js`.

## Publicação no Railway

O `railway.json` mantém instalação, inicialização com `npm start` e health check em `/api/health`.

Configure `NODE_ENV=production`, credenciais próprias, `PUBLIC_URL` e SMTP. Use volume persistente e aponte `DB_PATH` para ele, por exemplo `/data/barbearia.db`, com permissão de escrita pelo processo Node.js.

Mantenha uma instância para a rotina atual de lembretes. Antes de atualizar dados reais, mantenha backup consistente do SQLite e valide a restauração. A auditoria executou migrações em bancos de teste e não acessou o banco hospedado.

A configuração considera um proxy confiável. HTTPS, retenção e backup dependem da hospedagem. As fontes usam serviço externo com alternativas locais; as fotografias são servidas pelo próprio projeto. As alterações são preparadas para integração por pull request; a publicação é uma etapa separada.

## Confiabilidade e recuperação

A operação conta com backups locais agendados, checksum, verificação de integridade e ensaio de restauração em base separada. A recuperação conserva o banco existente e mantém os lembretes pausados até conferência explícita.

Os lembretes usam reservas persistentes no SQLite e tentativas limitadas à janela de envio. A sessão administrativa mantém uma alternativa em memória quando o armazenamento do navegador é bloqueado. Os preços redondos e a consulta por telefone ou e-mail permanecem iguais.

Os comandos, as condições de retomada e os limites estão em [Operação e recuperação](docs/operacao.md). A comprovação de posse do contato permanece como proposta de produto. O workflow de qualidade executa lint e testes com Chromium obrigatório e envio simulado de e-mail.

Nesta revisão de confiabilidade, o [CI com Chromium obrigatório](https://github.com/Mateus1804/barbearia-do-sema/actions/runs/40159900090) aprovou **122 testes, sem falhas ou testes pulados**, além do lint. Foram cobertos bloqueios de armazenamento, backup com recuperação isolada, integridade e retenção, tentativas de lembretes e concorrência entre conexões SQLite. Os testes não acessaram a produção nem enviaram e-mails reais.
