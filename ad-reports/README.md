# Relatórios de publicidade do Portal Trivox

Uma captura real por dia, em Google Chrome no Linux, com painel tint2 de aparência semelhante ao Windows e os aplicativos reais Mousepad e galculator abertos. O horário muda entre dias consecutivos, entre 08h e 17h59 de Brasília, com minutos variados. O relógio e a data são os do sistema sincronizado; nenhum horário é inserido artificialmente na foto. O desktop tem 1920 × 1800 para enquadrar as cinco posições de publicidade hoje preenchidas na página inicial.

## WhatsApp

No grupo do Trivox: `menu` → `[9] Relatório de publicidade`, ou Publicidade → `[4] Relatório de publicidade`. Também aceita `relatório` no grupo ou no privado do bot.

O bot verifica se o solicitante pertence ao grupo do Trivox e continua no privado, pedindo primeiro a data inicial e depois a final, em DD/MM/AAAA. O envio contém apenas imagens, em ordem cronológica, com DD/MM/AAAA na legenda. As perguntas e mensagens de erro são privadas; não há texto de abertura ou conclusão misturado às fotos. O período máximo por solicitação é 366 dias. A sessão de escolha expira após 30 minutos.

## Armazenamento e operação

- Fontes e backups operacionais: `/root/trivox-ad-reports-20261111/`.
- Originais PNG, JSON de evidência e índice SQLite: `/var/lib/trivox-ad-reports/`.
- Serviço isolado: `trivox-ad-captures`, gerenciado pelo Compose deste diretório, com restart automático, limite de 1 GiB e 1 CPU, sem porta publicada no host.
- Rede privada: `trivox-ad-reports-net`; somente o bot precisa acessar a API. Todas as rotas de relatório e imagem exigem um segredo próprio. A verificação de integridade SHA-256 acontece antes do envio.
- Segredos ficam fora do repositório, em `capture.env` protegido na VPS e nas variáveis do serviço WhatsApp/Dokploy: `TRIVOX_AD_REPORTS_URL` e `TRIVOX_AD_REPORTS_TOKEN`.
- Não há exclusão automática dos comprovantes. Acompanhar o espaço em disco e definir retenção conforme a operação desejar.

O serviço persiste o agendamento. Reinicialização não duplica uma foto já salva. Se perder o horário enquanto estiver desligado, pode recuperar uma captura no mesmo dia, sempre com a hora real da recuperação. Dias anteriores não são reconstruídos. Falhas de carregamento ou enquadramento têm até três tentativas, com 15 minutos de intervalo, e ficam registradas no status.

A captura verifica que todos os banners presentes na página inicial estão carregados e visíveis. Se futuramente houver múltiplos banners em rotação no mesmo espaço, ou publicidade exclusiva de outra página, uma única foto não consegue documentar tudo; será preciso rever o enquadramento ou a quantidade de imagens. O sistema não força a exibição, não altera o conteúdo do portal e não monta fotografias. A imagem demonstra o instante capturado e não certifica veiculação contínua.

## Validação

`python3 -m unittest discover -s capture -p test_app.py -v`

Na imagem Node do bot, com os fontes e testes montados sem o volume de autenticação:

`node --experimental-test-module-mocks --test test/*.test.js`

Inclui calendário e fuso brasileiro, uma captura por dia, reinicialização sem duplicação, autenticação da API, isolamento de caminhos, autorização dos membros, conversas privadas com aliases PN/LID, validação de períodos, integridade dos arquivos, legendas somente com a data e preservação das funcionalidades anteriores do bot.
