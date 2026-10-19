# Barbearia do Semá — agendamento online

Aplicação full-stack responsiva para a Barbearia do Semá, em Sabará/MG. Inclui landing page, consulta de horários disponíveis, reserva com cadastro automático de cliente, área do cliente, painel administrativo e API REST. O projeto usa Express + SQLite e envia lembretes por SMTP quando um serviço de e-mail está configurado.

## Requisitos

- Node.js 22 ou superior (compatível com Node.js 24)
- npm

## Rodar localmente

```bash
npm install
copy .env.example .env
```

No Windows, a dependência SQLite foi atualizada para uma versão com binários pré-compilados para Node.js 24, evitando exigir Visual Studio C++ na instalação normal. Se você já tentou instalar e falhou, apague a pasta `node_modules` e o arquivo `package-lock.json` antes de rodar `npm install` novamente.

Abra o arquivo `.env` e configure pelo menos `ADMIN_PASSWORD` e `JWT_SECRET`. Depois:

```bash
npm run dev
```

Acesse **http://localhost:3000**. Para iniciar sem modo de desenvolvimento, use `npm start`.

### Primeiro acesso administrativo

Para demonstração local, se as variáveis não forem alteradas, o acesso inicial é:

- E-mail: `sema@barbeariadosema.com.br`
- Senha: `Sema@2026!`

**Antes de publicar:** altere a senha e defina um `JWT_SECRET` único e longo. Não envie seu `.env` para o Git.

## Configurar lembretes por e-mail

Preencha no `.env` as variáveis `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` e `EMAIL_FROM`. O `.env.example` traz os campos vazios para não ativar o envio com credenciais de exemplo. Para Gmail, use uma senha de app, e não a senha normal da conta. O envio é feito por SMTP com Nodemailer; documentação: https://nodemailer.com/smtp.

O servidor verifica a agenda a cada minuto. O lembrete de 24 horas só é enviado se a última criação ou alteração do agendamento tiver ocorrido com pelo menos 24 horas de antecedência; o de 3 horas segue a mesma regra, exigindo pelo menos 3 horas. Cada lembrete é enviado uma única vez, dentro de uma janela de 15 minutos após o momento previsto, e o envio fica registrado no SQLite. Agendamentos feitos a menos de 3 horas do atendimento não recebem o lembrete de 3 horas; feitos a menos de 24 horas não recebem o de 24 horas. **O servidor precisa permanecer ligado e o SMTP precisa estar configurado**; uma indisponibilidade maior que a janela pode fazer um lembrete ser perdido. Os e-mails informam que o cancelamento pelo site só pode ser feito até 2 horas antes do atendimento.

## Como funciona

- Ao agendar pelo site ou painel, nome, telefone e e-mail são salvos/atualizados no pré-cadastro de clientes e vinculados à reserva. O e-mail agora é obrigatório.
- Para consultar agendamentos, o cliente informa **telefone + e-mail cadastrados juntos**. Isso evita que alguém acesse a agenda alheia sabendo somente um desses dados.
- Alteração e cancelamento exigem a mesma combinação telefone + e-mail e antecedência mínima de 2 horas.
- Os horários são gerados em intervalos de 30 minutos; a duração real do serviço fica armazenada e é arredondada para cima ao calcular os slots bloqueados.
- Domingo, almoço (12h–13h), dias fechados, bloqueios manuais, datas fora dos próximos 30 dias e horários que comecem em menos de 10 minutos são recusados. O agendamento pode ser feito no mesmo dia se houver um horário disponível. O barbeiro pode bloquear intervalos de horários ou fechar um dia inteiro pelo painel.
- A criação verifica conflitos dentro de uma transação SQLite; uma reserva concorrente recebe HTTP 409 se o horário já estiver ocupado.
- A opção do painel é uma **pré-confirmação de presença**; ela não impede o cliente de cancelar até 2 horas antes. Quando cancelado, o status muda para `cancelado` e o horário volta a ficar disponível.
- Datas e horários são tratados em `America/Sao_Paulo`; o instante é guardado em UTC e a agenda é apresentada no horário local.

## API principal

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/health` | Saúde da API |
| GET | `/api/services` | Serviços e preços |
| GET | `/api/available-slots/:data/:service_id` | Horários livres |
| POST | `/api/appointments` | Criar agendamento |
| POST | `/api/authenticate` | Validar telefone + e-mail e listar os agendamentos da combinação |
| PUT | `/api/appointments/:id` | Editar agendamento |
| DELETE | `/api/appointments/:id` | Cancelar agendamento do cliente |
| POST | `/admin/login` | Entrar como Semá |
| GET | `/admin/available-slots/:data/:service_id` | Horários livres no painel (token Bearer) |
| GET | `/admin/appointments?de=AAAA-MM-DD&ate=AAAA-MM-DD` | Listar agenda (token Bearer) |
| POST | `/admin/appointments` | Criar agendamento pelo painel |
| POST | `/admin/appointments/:id/confirm` | Pré-confirmar presença |
| POST | `/admin/appointments/:id/cancel` | Cancelar pelo painel |
| POST | `/admin/block-slots` | Bloquear um intervalo de horários |
| DELETE | `/admin/block-slots/:id` | Remover bloqueio |
| POST | `/admin/holidays` | Cadastrar feriado |
| DELETE | `/admin/holidays/:id` | Remover feriado |

## Testes

```bash
npm test
```

São ~75 testes, todos com banco em memória (não tocam nos dados reais), e rodam em cerca de um minuto:

| Arquivo | O que protege |
|---|---|
| `test/booking-rules.test.js` | Regra única de telefone (fixo, celular com DDD + 9 + 8 dígitos, internacional com `+`), e-mail e lista de pendências do formulário |
| `test/core.test.js` | Slots de 30 min, fuso de Brasília, antecedência mínima de 10 min, lembretes de 24h/3h |
| `test/api.test.js` e `test/appointments-lifecycle.test.js` | Fluxo completo pela API: agendar, consultar, remarcar, cancelar, regra das 2 horas, almoço, bloqueios, dias fechados, login e ações do administrador, validações de entrada |
| `test/booking-form.browser.test.js` | Formulário no navegador: lista do que falta, campos em vermelho, máscara do telefone, dia padrão, envio e proteção contra respostas atrasadas |
| `test/frontend-resilience.browser.test.js` | Sessão do admin salva ao recarregar, checkbox do WhatsApp ausente no HTML, falhas de rede (mensagem "Verifique sua conexão") sem mascarar erros do servidor |
| `test/layout.browser.test.js` | Layout em desktop, tablet e celular: sem rolagem lateral, cards alinhados, mapa e títulos centralizados, animações que não deslocam elementos |

Os testes de navegador usam o Chromium do Playwright. Na primeira vez, instale-o com `npx playwright install chromium`; se ele não estiver instalado, esses testes são pulados em vez de falhar. Para rodar um arquivo só: `node --test test/layout.browser.test.js`.

## Qualidade de código

```bash
npm run lint
```

O ESLint (`eslint.config.js`) varre servidor, frontend e testes em busca de variáveis/funções sem uso, `var`, comparações com `==` e erros de sintaxe. Rode junto com `npm test` antes de cada commit.

## Publicação

O Express serve tanto a interface quanto a API na mesma origem, então é possível publicar como um único serviço Node (por exemplo, Railway). Configure também as variáveis SMTP para os lembretes funcionarem em produção. Defina `NODE_ENV=production`, `ADMIN_PASSWORD`, `JWT_SECRET` e `DB_PATH`. Para persistir a agenda entre reinicializações, configure um volume persistente e aponte `DB_PATH` para ele, por exemplo `/data/barbearia.db`. Sem volume persistente, um disco efêmero pode apagar o banco ao reiniciar/reimplantar.

Este repositório é um MVP acadêmico. Antes de uso comercial, revise as políticas de backup e retenção de dados pessoais, o acesso administrativo e a infraestrutura de persistência.
