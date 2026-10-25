# Operação, recuperação e lembretes

## Configuração

Os backups locais ficam habilitados por padrão para bancos em arquivo. O primeiro ciclo ocorre após a inicialização; os seguintes usam BACKUP_INTERVAL_HOURS, com padrão de 24 horas. BACKUP_KEEP mantém pelo menos os sete pares verificados mais recentes; arquivos com menos de uma hora não entram na exclusão por retenção.

BACKUP_DIR aponta por padrão para a pasta backups ao lado do banco. O destino deve ficar fora de public/ e em volume persistente. Arquivos são criados com modo 0600 e novos diretórios com 0700 nos sistemas que oferecem essas permissões. Os arquivos contêm contatos e dados administrativos e não devem ser publicados ou enviados como artefatos de CI.

O backup local protege a recuperação lógica, mas não cobre a perda do próprio volume. A conservação de uma cópia independente continua sendo uma responsabilidade da hospedagem. BACKUP_ENABLED=false desativa o agendamento; bancos :memory: não iniciam a rotina.

## Formato e conferência

Cada backup contém um arquivo SQLite e um arquivo .json associado, ambos necessários. A versão 1 identifica o formato, data, SHA-256, contagens e impressão dos registros. O checksum detecta alterações e não comprova a autoria de um arquivo desconhecido.

A criação usa a API de backup do SQLite para incluir os dados ainda no WAL. A cópia passa a usar journal DELETE, é inspecionada com integrity_check e foreign_key_check e recebe um ensaio real de restauração em outro arquivo antes de ser concluída. Triggers e views não fazem parte do esquema suportado.

    npm run backup -- create
    npm run backup -- verify /volume/backups/ARQUIVO.sqlite
    npm run backup -- restore /volume/backups/ARQUIVO.sqlite /volume/recuperacao/agenda.sqlite

A restauração recusa destinos existentes. Os registros são validados em arquivo temporário e publicados sem substituir o banco original. O arquivo recuperado pode ser conferido em uma instância isolada antes da troca de DB_PATH, que ocorre com a aplicação parada. O banco anterior deve ser conservado até a conclusão da conferência.

## Retomada dos lembretes

A base restaurada mantém reminders_paused=1. Isso evita que marcadores antigos de envio sejam reutilizados sem conferência operacional. Não há envio de e-mails no ensaio de recuperação.

Após conferir os registros e decidir a retomada no banco selecionado:

    npm run backup -- resume-reminders --confirmar

REMINDERS_ENABLED=false também impede o envio, independentemente da pausa do banco. A retomada apenas libera o próximo ciclo; as regras de elegibilidade de 24 horas, três horas e janela de 15 minutos continuam aplicadas.

## Controle persistente de entregas

reminder_deliveries identifica cada envio por reserva, tipo, programação e início. Uma transação imediata adquire a reserva de execução; outros serviços ou conexões não assumem uma reserva ainda válida. Há renovação a cada 30 segundos e recuperação após expirar a reserva de dois minutos.

Falhas de transporte recebem até cinco tentativas, com recuo de 1, 2, 4 e 5 minutos, limitado à janela original. Programações canceladas ou substituídas são reavaliadas. O Message-ID é estável nas tentativas e os logs guardam identificadores e códigos técnicos, sem o corpo do e-mail.

SMTP não oferece confirmação transacional junto ao SQLite. Uma interrupção após aceitação do e-mail e antes do registro local pode causar reenvio após a recuperação. A reserva reduz concorrência; não promete entrega exatamente uma vez. O volume SQLite continua exigindo as condições de acesso da hospedagem.

## Armazenamento no navegador

A sessão administrativa usa sessionStorage quando disponível e memória quando o navegador nega acesso. Na alternativa em memória, recarregar a página exige novo login. Não há cópia do token para localStorage. A saída encerra a sessão da página mesmo se o navegador negar a remoção do armazenamento.

Uma remoção recusada não permite garantir a limpeza de um token já persistido em visita anterior; a validade continua sendo verificada pelo servidor. A mudança não acrescenta revogação de JWT.

## Proposta de identificação do cliente

A consulta por telefone OU e-mail e as autorizações atuais permanecem iguais. Uma evolução poderá comprovar a posse do contato por link temporário ou código antes de consultar e alterar reservas. A escolha de canal, recuperação de acesso, expiração e impacto na experiência precisam de decisão de produto; esse fluxo não foi implementado nesta etapa.

## Referência de validação

Antes das alterações, o lint passou e o ambiente local executou 65 testes aprovados, com 39 testes de navegador pulados por ausência do Chromium. O workflow novo instala Chromium e exige REQUIRE_BROWSER_TESTS=1: indisponibilidade do navegador é falha no CI.

Os testes adicionados usam somente banco temporário, contatos fictícios e transporte SMTP simulado. Os resultados finais pertencem à execução vinculada no pull request. Não houve restauração ou acesso ao banco de produção.
