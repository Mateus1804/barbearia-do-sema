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

O servidor verifica a agenda a cada minuto e envia um lembrete quando o atendimento se aproxima de 24 horas e outro quando faltam cerca de 3 horas. Os envios realizados ficam registrados no SQLite para evitar repetição. **O servidor precisa permanecer ligado e o SMTP precisa estar configurado**; se o serviço estiver desligado ou o provedor recusar a mensagem, não é possível garantir o envio na hora exata. Os e-mails informam que o cancelamento pelo site só pode ser feito até 2 horas antes do atendimento.

## Como funciona

- Ao agendar pelo site ou painel, nome, telefone e e-mail são salvos/atualizados no pré-cadastro de clientes e vinculados à reserva. O e-mail agora é obrigatório.
- Para consultar agendamentos, o cliente informa **telefone + e-mail cadastrados juntos**. Isso evita que alguém acesse a agenda alheia sabendo somente um desses dados.
- Alteração e cancelamento exigem a mesma combinação telefone + e-mail e antecedência mínima de 2 horas.
- Há no máximo 3 tentativas incorretas por telefone por dia.
- Os horários são gerados em intervalos de 30 minutos; a duração real do serviço fica armazenada e é arredondada para cima ao calcular os slots bloqueados.
- Domingo, almoço (12h–13h), feriados, bloqueios manuais, datas fora dos próximos 30 dias e horários passados são recusados. Clientes não podem agendar no mesmo dia; o painel administrativo permite encaixes no dia, sempre com 2 horas mínimas de antecedência.
- A criação verifica conflitos dentro de uma transação SQLite; uma reserva concorrente recebe HTTP 409 se o horário já estiver ocupado.
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
| POST | `/admin/appointments/:id/confirm` | Marcar presença |
| POST | `/admin/appointments/:id/cancel` | Cancelar pelo painel |
| POST | `/admin/block-slots` | Bloquear horário |
| DELETE | `/admin/block-slots/:id` | Remover bloqueio |
| POST | `/admin/holidays` | Cadastrar feriado |
| DELETE | `/admin/holidays/:id` | Remover feriado |

## Testes

```bash
npm test
```

Os testes cobrem o arredondamento dos slots, formato de telefone e conversão do fuso horário.

## Publicação

O Express serve tanto a interface quanto a API na mesma origem, então é possível publicar como um único serviço Node (por exemplo, Railway). Configure também as variáveis SMTP para os lembretes funcionarem em produção. Defina `NODE_ENV=production`, `ADMIN_PASSWORD`, `JWT_SECRET` e `DB_PATH`. Para persistir a agenda entre reinicializações, configure um volume persistente e aponte `DB_PATH` para ele, por exemplo `/data/barbearia.db`. Sem volume persistente, um disco efêmero pode apagar o banco ao reiniciar/reimplantar.

Este repositório é um MVP acadêmico. Antes de uso comercial, revise as políticas de backup e retenção de dados pessoais, o acesso administrativo e a infraestrutura de persistência.
