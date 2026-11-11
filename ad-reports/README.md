# Relatórios de publicidade do Portal Trivox

Uma execução diária produz duas capturas reais em Google Chrome no Linux, com zoom padrão de 100% e desktop de 1920 × 1080. A primeira registra o Topo, com três banners; a segunda registra o Meio, com os dois banners dessa seção, após rolar a página normalmente. O painel tint2 tem aparência semelhante ao Windows e os aplicativos reais Mousepad e galculator ficam abertos. O horário muda entre dias consecutivos, entre 08h e 17h59 de Brasília, com minutos variados. O relógio e a data são os do sistema sincronizado; nenhum horário é inserido artificialmente na foto.

## WhatsApp

No grupo do Trivox: `menu` → `[9] Relatório de publicidade`, ou Publicidade → `[4] Relatório de publicidade`. Também aceita `relatório` no grupo ou no privado do bot.

O bot verifica se o solicitante pertence ao grupo do Trivox e continua no privado, perguntando Topo ou Meio, a data inicial e a final, em DD/MM/AAAA. Depois envia um único DOCX com todas as capturas disponíveis da seção escolhida, em ordem cronológica, identificadas por data. Não envia as imagens separadamente nem mensagens de abertura ou conclusão junto do arquivo. O período máximo por solicitação é 366 dias; relatórios com mais de 60 MB de imagens pedem um intervalo menor. A sessão de escolha expira após 30 minutos.

## Armazenamento e operação

- Fontes e backups operacionais: `/root/trivox-ad-reports-20261111/`.
- Originais PNG, JSON de evidência e índice SQLite: `/var/lib/trivox-ad-reports/`.
- Serviço isolado: `trivox-ad-captures`, gerenciado pelo Compose deste diretório, com restart automático, limite de 1 GiB e 1 CPU, sem porta publicada no host.
- Rede privada: `trivox-ad-reports-net`; somente o bot precisa acessar a API. Todas as rotas de relatório e imagem exigem um segredo próprio. A verificação de integridade SHA-256 acontece antes do envio.
- Segredos ficam fora do repositório, em `capture.env` protegido na VPS e nas variáveis do serviço WhatsApp/Dokploy: `TRIVOX_AD_REPORTS_URL` e `TRIVOX_AD_REPORTS_TOKEN`.
- Não há exclusão automática dos comprovantes. Acompanhar o espaço em disco e definir retenção conforme a operação desejar.

O serviço persiste o agendamento e admite uma imagem por dia por seção. Reinicialização não duplica um par já salvo. Se perder o horário enquanto estiver desligado, pode recuperar o par no mesmo dia, sempre com a hora real da recuperação. Dias anteriores não são reconstruídos. Falhas de carregamento ou enquadramento têm até três tentativas, com 15 minutos de intervalo, e ficam registradas no status. As capturas completas do formato anterior permanecem arquivadas como `legacy` e não são reclassificadas como Topo ou Meio.

A captura verifica três banners carregados e visíveis no Topo e dois no Meio. Se futuramente houver múltiplos banners em rotação no mesmo espaço ou mudanças nas posições, será preciso rever o enquadramento. O sistema não força a exibição, não altera o conteúdo do portal e não monta fotografias. Cada imagem demonstra o instante capturado e não certifica veiculação contínua. O DOCX preserva os bytes dos PNGs originais, com duas capturas por página, e fica em `/var/lib/trivox-ad-reports/reports/`.

## Validação

`python3 -m unittest discover -s capture -p 'test_*.py' -v`

Na imagem Node do bot, com os fontes e testes montados sem o volume de autenticação:

`node --experimental-test-module-mocks --test test/*.test.js`

Inclui calendário e fuso brasileiro, uma captura por dia, reinicialização sem duplicação, autenticação da API, isolamento de caminhos, autorização dos membros, conversas privadas com aliases PN/LID, validação de períodos, integridade dos arquivos, legendas somente com a data e preservação das funcionalidades anteriores do bot.
