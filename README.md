# CTX Baixar Videos e Imagens

Extensao local para Google Chrome que mostra um pequeno botao apenas com o icone de download quando o mouse passa sobre um video ou uma imagem com pelo menos 80 x 80 pixels.

## Instalar no Chrome

Baixe o arquivo **CTX-Baixar-Videos-0.44.zip** na [pagina de releases](https://github.com/convertix-digital/ctx-baixar-videos/releases/latest) e extraia para uma pasta permanente no computador. O Chrome carrega a pasta extraida, nao o ZIP. Nao apague nem mova essa pasta depois de instalar.

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor** no canto superior direito.
3. Clique em **Carregar sem compactacao**.
4. Selecione a pasta extraida que contem o arquivo `manifest.json`.

Para atualizar, substitua os arquivos da pasta instalada pela nova versao e clique em **Recarregar** na extensao em `chrome://extensions`. Depois atualize as paginas em que deseja usar o botao.

Versao atual: **0.44**, experimental. A compatibilidade depende do formato disponibilizado pelo site; nao ha garantia de funcionamento em todos os sites.

Depois, abra ou recarregue a pagina. Passe o mouse sobre o video ou imagem e clique no icone de download.

Por padrao, a extensao usa **Salvar como**. Um unico clique no pequeno icone abre diretamente o seletor nativo do Chrome, antes de baixar as partes do video. Nao existe popup intermediario nem segundo botao. O proprio Chrome volta para a ultima pasta usada. Para salvar automaticamente na pasta Downloads, clique no icone da extensao na barra do Chrome e selecione **Download direto**. A preferencia fica somente no armazenamento local do Chrome e pode ser alterada a qualquer momento.

No Instagram, a extensao procura primeiro o MP4 progressivo do post ou Reel, inclusive quando ele foi aberto como popup no perfil. As partes DASH recebidas pelo player sao usadas apenas como alternativa quando o MP4 direto nao esta disponivel.

Em paginas com SmartPlayer da Vturb/Converte.ai, a extensao reconhece o componente fechado e baixa a playlist HLS observada depois que o video e iniciado.

Quando o player usa streaming segmentado, inicie o video por alguns segundos e clique em **Baixar**. A extensao reutiliza no proprio contexto do player a playlist e o modelo de requisicao HLS que ele ja recebeu, baixa os segmentos seguintes em paralelo e grava o resultado localmente sem recodificar. O tempo depende da velocidade da internet, nao da duracao do video.

Em playlists HLS e Vimeo DASH, no modo **Salvar como**, primeiro escolha o nome e a pasta no dialogo nativo do Chrome. A extensao grava as partes diretamente no arquivo escolhido. Mantenha a pagina do video aberta ate aparecer a mensagem **Video salvo no local escolhido**. Fechar ou recarregar a aba antes da conclusao interrompe o download. Nao existe servidor proprio, telemetria ou comunicacao com qualquer sistema externo.

Ao entregar o arquivo final, o Chrome respeita a opcao escolhida no painel da extensao. Em **Salvar como**, o nome sugerido e validado como `.mp4` ou `.ts`, mas pode ser alterado junto com a pasta de destino antes de salvar.

Quando ocorrer um erro, o aviso exibira o botao **Copiar diagnostico**. Ele copia a mensagem, a versao da extensao, o estado do player, todas as etapas executadas, codigos HTTP ou do gerenciador de downloads, bytes recebidos, tipos de midia e um resumo das fontes detectadas. URLs assinadas, valores de parametros, cookies, tokens e caminhos locais sao removidos do relatorio. O texto visivel tambem pode ser selecionado manualmente.

## Privacidade e permissoes

- Nao existe servidor, API, telemetria, conta ou dependencia externa.
- A extensao nao envia dados para terceiros.
- A permissao `downloads` e usada somente depois do clique no botao.
- A permissao `storage` guarda apenas a escolha entre **Salvar como** e **Download direto** no proprio Chrome.
- O script precisa rodar nas paginas HTTP/HTTPS para localizar elementos `<video>` e `<img>` e posicionar o botao sobre eles.
- O download e feito diretamente da URL que a pagina ou o proprio player atribuiu ao video ou imagem.
- No Instagram, as partes ja recebidas pelo player ficam apenas na memoria da pagina ate o download ou o descarte pelo limite interno do cache.
- No modo **Salvar como**, os segmentos sao gravados diretamente no arquivo escolhido enquanto a pagina permanece aberta.
- Em players do Vimeo, a extensao consulta a configuracao do proprio iframe autenticado e escolhe a versao MP4 progressiva de maior resolucao oferecida pelo Vimeo.

## Limites tecnicos

A extensao baixa imagens JPG, PNG, WebP, GIF, AVIF, BMP e SVG; videos diretos como MP4 e WebM; Instagram progressivo ou DASH; Vimeo em DASH fragmentado; HLS com audio e video combinados, como o formato TS usado pelo PandaVideo; e HLS fMP4 com trilhas separadas de audio e video, unidas localmente em um unico MP4 sem recodificacao. Ela nao burla autenticacao, criptografia ou DRM. HLS criptografado e HLS com trilhas separadas que nao usem fMP4 continuam fora do escopo.

Use apenas em conteudos que voce tem permissao para baixar.
