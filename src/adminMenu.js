import axios from 'axios';

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

function normalize(value) {
  return String(value || '').trim();
}

function lower(value) {
  return normalize(value).toLocaleLowerCase('pt-BR');
}

function keyFor(remoteJid, participant) {
  return `${remoteJid}:${participant || remoteJid}`;
}

function mainMenu(config = {}) {
  const brand = config.adminMenuBrandName || 'Paraná Pop';
  const videoLine = config.adminMenuHasVideo === false ? '' : '\n[8] Vídeo Padrão';
  return `🟢 *ADMIN ${brand.toLocaleUpperCase('pt-BR')}*\n\n[1] Visão Geral\n[2] Matérias\n[3] Usuários\n[4] Insights\n[5] Configurações / SEO\n[6] Publicidade\n[7] Imagem Padrão${videoLine}\n\nDigite o número da opção.\nA qualquer momento: *menu*, *voltar* ou *sair*.`;
}

function postsMenu() {
  return `📰 *MATÉRIAS*\n\n[1] Nova Matéria\n[2] Excluir Matéria\n[3] Editar Matéria\n[4] Últimas Matérias\n[5] Buscar Matéria\n[0] Menu principal`;
}

function adsMenu() {
  return `📣 *PUBLICIDADE*\n\n[1] Nova Publicidade\n[2] Excluir Publicidade\n[3] Ver Publicidades\n[0] Menu principal`;
}

function settingsMenu() {
  return `⚙️ *CONFIGURAÇÕES / SEO*\n\n[1] Ver resumo\n[2] Alterar título do site\n[3] Alterar descrição do site\n[0] Menu principal`;
}

function formatPosts(posts = []) {
  if (!posts.length) return 'Nenhuma matéria encontrada.';
  return posts.map((post, index) => {
    const date = post.published_at ? ` — ${post.published_at}` : '';
    return `[${index + 1}] #${post.id} ${post.title}${date}`;
  }).join('\n');
}

function formatAds(slots = []) {
  if (!slots.length) return 'Nenhum local de publicidade encontrado.';
  return slots.map((slot, index) => {
    const dimensions = slot.dimensions ? ` — Medida: ${slot.dimensions}` : '';
    const hint = slot.hint ? ` — ${slot.hint}` : '';
    return `[${index + 1}] #${slot.id} ${slot.name} (${slot.key}) — ${slot.is_active ? 'ATIVA' : 'inativa'}${slot.has_content ? '' : ' — vazia'}${dimensions}${hint}`;
  }).join('\n');
}

function setSession(key, data) {
  sessions.set(key, { ...data, updatedAt: Date.now() });
}

function getSession(key) {
  const session = sessions.get(key);
  if (!session) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL) {
    sessions.delete(key);
    return null;
  }
  return session;
}

async function api(config, action, payload = {}) {
  const response = await axios.post(
    config.adminMenuApiUrl,
    { action, ...payload, token: config.adminMenuToken },
    {
      timeout: 60000,
      headers: { 'X-Bot-Token': config.adminMenuToken, 'Content-Type': 'application/json' }
    }
  );
  return response.data;
}

function selected(items, text) {
  const number = Number.parseInt(normalize(text), 10);
  if (Number.isFinite(number) && number >= 1 && number <= items.length) return items[number - 1];
  const exactId = normalize(text).match(/^#?(\d+)$/);
  if (exactId) return items.find((item) => item.id === Number(exactId[1])) || null;
  return null;
}

async function showPostMatches(config, query) {
  const result = await api(config, 'posts.search', { query, limit: 10 });
  return result.posts || [];
}

async function beginPostSelection({ config, key, reply, purpose, query = '' }) {
  const posts = query ? await showPostMatches(config, query) : (await api(config, 'posts.list', { limit: 10 })).posts || [];
  if (!posts.length) {
    await reply(query ? 'Não encontrei matérias semelhantes. Digite outro título ou *voltar*.' : 'Não há matérias cadastradas.');
    return;
  }
  setSession(key, { area: 'posts', step: `${purpose}_select`, posts, purpose });
  await reply(`${purpose === 'delete' ? '🗑️ Escolha a matéria para excluir' : '✏️ Escolha a matéria para editar'}:\n\n${formatPosts(posts)}\n\nDigite o número, o ID ou outro trecho do título.`);
}

export function adminMenuConfigured(config) {
  return Boolean(config.adminMenuEnabled && config.adminMenuApiUrl && config.adminMenuToken && config.adminMenuGroupId);
}

export async function handleAdminMenu({ message, config, text, remoteJid, participant, reply, startPhotoFlow, startVideoFlow }) {
  if (message?.key?.fromMe || !remoteJid || remoteJid !== config.adminMenuGroupId) return false;
  const value = normalize(text);
  const command = lower(value);
  const key = keyFor(remoteJid, participant);

  if (command === 'menu' || command === '/menu') {
    if (!adminMenuConfigured(config)) {
      await reply(`⚠️ O Menu Admin do ${config.adminMenuBrandName || 'Paraná Pop'} ainda não está configurado no Railway.`);
      return true;
    }
    setSession(key, { area: 'main', step: 'main' });
    await reply(mainMenu(config));
    return true;
  }

  const session = getSession(key);
  if (!session) return false;

  if (command === 'sair' || command === '/sair' || command === 'cancelar' || command === '/cancelar') {
    sessions.delete(key);
    await reply('✅ Menu encerrado. Digite *menu* quando precisar novamente.');
    return true;
  }
  if (command === 'voltar') {
    setSession(key, { area: 'main', step: 'main' });
    await reply(mainMenu(config));
    return true;
  }

  try {
    if (session.step === 'main') {
      if (value === '1') {
        const result = await api(config, 'overview');
        await reply(`📊 *VISÃO GERAL*\n\n👁️ Page views totais: ${result.page_views_total}\n🕐 Page views (24h): ${result.page_views_24h}\n📰 Total de matérias: ${result.posts_total}\n✍️ Matérias locais: ${result.local_posts}\n🌐 Matérias WordPress: ${result.wp_posts}\n🏷️ Categorias: ${result.categories_total}\n📣 Publicidades ativas: ${result.active_ads}\n👥 Usuários ativos: ${result.active_users}\n\nDigite *menu* para voltar.`);
        return true;
      }
      if (value === '2') { setSession(key, { area: 'posts', step: 'posts_menu' }); await reply(postsMenu()); return true; }
      if (value === '3') {
        const result = await api(config, 'users.list');
        const users = result.users || [];
        await reply(`👥 *USUÁRIOS*\n\n${users.length ? users.map((u, i) => `[${i + 1}] ${u.email} — ${u.is_active ? 'ativo' : 'inativo'}${u.is_admin ? ' — admin' : ''}`).join('\n') : 'Nenhum usuário cadastrado.'}\n\nAlterações de permissão continuam protegidas no painel web.`);
        return true;
      }
      if (value === '4') {
        const result = await api(config, 'insights');
        await reply(`📈 *INSIGHTS — ÚLTIMOS 30 DIAS*\n\n👁️ Visualizações: ${result.page_views}\n👤 Visitantes: ${result.visitors}\n🧭 Sessões: ${result.sessions}\n📄 Páginas por sessão: ${result.pages_per_session}\n⏱️ Duração média: ${result.avg_duration_seconds}s\n↩️ Rejeição: ${result.bounce_rate}%\n\n*Matérias mais vistas*\n${formatPosts(result.popular_posts || [])}`);
        return true;
      }
      if (value === '5') { setSession(key, { area: 'settings', step: 'settings_menu' }); await reply(settingsMenu()); return true; }
      if (value === '6') { setSession(key, { area: 'ads', step: 'ads_menu' }); await reply(adsMenu()); return true; }
      if (value === '7') {
        if (typeof startPhotoFlow !== 'function') {
          await reply('⚠️ O gerador de imagem padrão não está disponível neste momento. Você ainda pode usar */foto*.');
          return true;
        }
        sessions.delete(key);
        await startPhotoFlow();
        return true;
      }
      if (value === '8') {
        if (typeof startVideoFlow !== 'function') {
          await reply('⚠️ O gerador de vídeo padrão não está disponível neste momento.');
          return true;
        }
        sessions.delete(key);
        await startVideoFlow();
        return true;
      }
      await reply(`Opção inválida.\n\n${mainMenu(config)}`); return true;
    }

    if (session.step === 'posts_menu') {
      if (value === '0') { setSession(key, { area: 'main', step: 'main' }); await reply(mainMenu(config)); return true; }
      if (value === '1') { setSession(key, { area: 'posts', step: 'new_title', draft: {} }); await reply('🆕 *NOVA MATÉRIA*\n\nDigite o título da matéria.'); return true; }
      if (value === '2') { await beginPostSelection({ config, key, reply, purpose: 'delete' }); return true; }
      if (value === '3') { await beginPostSelection({ config, key, reply, purpose: 'edit' }); return true; }
      if (value === '4') { const r = await api(config, 'posts.list', { limit: 10 }); await reply(`📰 *ÚLTIMAS MATÉRIAS*\n\n${formatPosts(r.posts)}\n\n${postsMenu()}`); return true; }
      if (value === '5') { setSession(key, { area: 'posts', step: 'search_query' }); await reply('🔎 Digite parte do título da matéria.'); return true; }
      await reply(postsMenu()); return true;
    }

    if (session.step === 'search_query') {
      const posts = await showPostMatches(config, value);
      await reply(`🔎 *RESULTADOS*\n\n${formatPosts(posts)}\n\n${postsMenu()}`);
      setSession(key, { area: 'posts', step: 'posts_menu' }); return true;
    }

    if (session.step === 'new_title') {
      if (value.length < 5) { await reply('Digite um título com pelo menos 5 caracteres.'); return true; }
      setSession(key, { ...session, step: 'new_content', draft: { title: value } });
      await reply('Agora envie o texto completo da matéria.'); return true;
    }
    if (session.step === 'new_content') {
      if (value.length < 20) { await reply('O texto está curto. Envie pelo menos 20 caracteres.'); return true; }
      const categories = (await api(config, 'categories.list')).categories || [];
      setSession(key, { ...session, step: 'new_category', categories, draft: { ...session.draft, content: value } });
      await reply(`Escolha a categoria:\n\n${categories.map((c, i) => `[${i + 1}] ${c.name}`).join('\n')}\n\nDigite *0* para publicar sem categoria.`); return true;
    }
    if (session.step === 'new_category') {
      const category = value === '0' ? null : selected(session.categories || [], value);
      if (value !== '0' && !category) { await reply('Categoria inválida. Digite um número da lista ou 0.'); return true; }
      const result = await api(config, 'posts.create', { ...session.draft, category_id: category?.id || null });
      setSession(key, { area: 'posts', step: 'posts_menu' });
      await reply(`✅ Matéria criada com sucesso!\n\n#${result.post.id} ${result.post.title}\n${result.post.url || ''}\n\n${postsMenu()}`); return true;
    }

    if (session.step === 'delete_select' || session.step === 'edit_select') {
      let post = selected(session.posts || [], value);
      if (!post) {
        const matches = await showPostMatches(config, value);
        if (matches.length === 1) post = matches[0];
        else if (matches.length > 1) {
          setSession(key, { ...session, posts: matches });
          await reply(`Encontrei matérias semelhantes:\n\n${formatPosts(matches)}\n\nDigite o número correto.`); return true;
        }
      }
      if (!post) { await reply('Não encontrei essa matéria. Digite outro título, número ou ID.'); return true; }
      if (session.step === 'delete_select') {
        setSession(key, { area: 'posts', step: 'delete_confirm', post });
        await reply(`⚠️ Confirma excluir definitivamente esta matéria?\n\n#${post.id} ${post.title}\n\nDigite *SIM* para excluir ou *NÃO* para cancelar.`); return true;
      }
      setSession(key, { area: 'posts', step: 'edit_field', post });
      await reply(`✏️ Editando: #${post.id} ${post.title}\n\n[1] Título\n[2] Texto\n[3] Resumo\n[4] Imagem destacada (URL)\n[5] Categoria\n[0] Cancelar`); return true;
    }
    if (session.step === 'delete_confirm') {
      if (['sim', 's'].includes(command)) {
        await api(config, 'posts.delete', { post_id: session.post.id });
        setSession(key, { area: 'posts', step: 'posts_menu' });
        await reply(`✅ Matéria excluída: ${session.post.title}\n\n${postsMenu()}`); return true;
      }
      setSession(key, { area: 'posts', step: 'posts_menu' }); await reply(`Exclusão cancelada.\n\n${postsMenu()}`); return true;
    }
    if (session.step === 'edit_field') {
      if (value === '0') { setSession(key, { area: 'posts', step: 'posts_menu' }); await reply(postsMenu()); return true; }
      const fields = { '1': 'title', '2': 'content', '3': 'excerpt', '4': 'featured_image', '5': 'category' };
      const field = fields[value];
      if (!field) { await reply('Escolha uma opção de 0 a 5.'); return true; }
      if (field === 'category') {
        const categories = (await api(config, 'categories.list')).categories || [];
        setSession(key, { ...session, step: 'edit_value', field, categories });
        await reply(`Escolha a nova categoria:\n\n${categories.map((c, i) => `[${i + 1}] ${c.name}`).join('\n')}\n\nDigite 0 para remover as categorias.`); return true;
      }
      setSession(key, { ...session, step: 'edit_value', field });
      await reply(`Envie o novo valor para *${field}*.`); return true;
    }
    if (session.step === 'edit_value') {
      let patch = {};
      if (session.field === 'category') {
        const category = value === '0' ? null : selected(session.categories || [], value);
        if (value !== '0' && !category) { await reply('Categoria inválida.'); return true; }
        patch.category_id = category?.id || null;
      } else patch[session.field] = value;
      const result = await api(config, 'posts.update', { post_id: session.post.id, ...patch });
      setSession(key, { area: 'posts', step: 'posts_menu' });
      await reply(`✅ Matéria atualizada: ${result.post.title}\n\n${postsMenu()}`); return true;
    }

    if (session.step === 'ads_menu') {
      if (value === '0') { setSession(key, { area: 'main', step: 'main' }); await reply(mainMenu(config)); return true; }
      if (value === '1') {
        const slots = (await api(config, 'ads.list')).slots || [];
        setSession(key, { area: 'ads', step: 'ad_new_slot', slots, draft: {} });
        await reply(`📍 Escolha onde colocar a publicidade:\n\n${formatAds(slots)}`); return true;
      }
      if (value === '2') {
        const slots = (await api(config, 'ads.list', { only_with_content: true })).slots || [];
        setSession(key, { area: 'ads', step: 'ad_delete_select', slots });
        await reply(`🗑️ Escolha a publicidade para remover:\n\n${formatAds(slots)}`); return true;
      }
      if (value === '3') { const r = await api(config, 'ads.list'); await reply(`📣 *PUBLICIDADES*\n\n${formatAds(r.slots)}\n\n${adsMenu()}`); return true; }
      await reply(adsMenu()); return true;
    }
    if (session.step === 'ad_new_slot') {
      const slot = selected(session.slots || [], value);
      if (!slot) { await reply('Local inválido. Digite o número ou ID.'); return true; }
      setSession(key, { ...session, step: 'ad_new_name', slot, draft: {} });
      await reply(`Local escolhido: *${slot.name}*\n📏 Medida ideal do banner: *${slot.dimensions || 'Consulte o tamanho no painel'}*\n${slot.hint ? `📝 ${slot.hint}\n` : ''}\nDigite um nome para identificar a publicidade.`); return true;
    }
    if (session.step === 'ad_new_name') {
      setSession(key, { ...session, step: 'ad_new_image', draft: { name: value } });
      await reply(`Perfeito. Agora envie a *URL pública da imagem do banner*\n\n📏 Tamanho recomendado: *${session.slot?.dimensions || 'Consulte o tamanho no painel'}*\n${session.slot?.hint ? `📝 Local: ${session.slot.hint}\n` : ''}\nExemplo de URL válida: https://site.com/banner.jpg`); return true;
    }
    if (session.step === 'ad_new_image') {
      if (!/^https?:\/\//i.test(value)) { await reply('Envie uma URL começando com http:// ou https://'); return true; }
      setSession(key, { ...session, step: 'ad_new_link', draft: { ...session.draft, image_url: value } });
      await reply('Envie o link de destino da publicidade ou digite *0* para usar #.'); return true;
    }
    if (session.step === 'ad_new_link') {
      const result = await api(config, 'ads.create', { slot_id: session.slot.id, ...session.draft, link_url: value === '0' ? '#' : value });
      setSession(key, { area: 'ads', step: 'ads_menu' });
      await reply(`✅ Publicidade ativada em *${result.slot.name}*.\n\n${adsMenu()}`); return true;
    }
    if (session.step === 'ad_delete_select') {
      const slot = selected(session.slots || [], value);
      if (!slot) { await reply('Publicidade inválida. Digite o número ou ID.'); return true; }
      setSession(key, { area: 'ads', step: 'ad_delete_confirm', slot });
      await reply(`⚠️ Confirma remover a publicidade de *${slot.name}*?\nO local continuará disponível no site.\n\nDigite *SIM* para confirmar.`); return true;
    }
    if (session.step === 'ad_delete_confirm') {
      if (['sim', 's'].includes(command)) await api(config, 'ads.delete', { slot_id: session.slot.id });
      setSession(key, { area: 'ads', step: 'ads_menu' });
      await reply(`${['sim', 's'].includes(command) ? '✅ Publicidade removida.' : 'Remoção cancelada.'}\n\n${adsMenu()}`); return true;
    }

    if (session.step === 'settings_menu') {
      if (value === '0') { setSession(key, { area: 'main', step: 'main' }); await reply(mainMenu(config)); return true; }
      if (value === '1') {
        const r = await api(config, 'settings.get');
        await reply(`⚙️ *CONFIGURAÇÕES / SEO*\n\nTítulo: ${r.site_title || '-'}\nDescrição: ${r.site_description || '-'}\nURL: ${r.site_url || '-'}\nLogo: ${r.logo_url || '-'}\n\n${settingsMenu()}`); return true;
      }
      if (value === '2' || value === '3') {
        setSession(key, { ...session, step: 'settings_value', field: value === '2' ? 'site_title' : 'site_description' });
        await reply(`Digite o novo ${value === '2' ? 'título do site' : 'texto de descrição do site'}.`); return true;
      }
      await reply(settingsMenu()); return true;
    }
    if (session.step === 'settings_value') {
      await api(config, 'settings.update', { [session.field]: value });
      setSession(key, { area: 'settings', step: 'settings_menu' });
      await reply(`✅ Configuração atualizada.\n\n${settingsMenu()}`); return true;
    }

    await reply(mainMenu(config));
    setSession(key, { area: 'main', step: 'main' });
    return true;
  } catch (error) {
    const messageText = error?.response?.data?.message || error?.message || 'erro interno';
    await reply(`⚠️ Não consegui concluir esta ação: ${messageText}\n\nDigite *menu* para recomeçar.`);
    sessions.delete(key);
    return true;
  }
}
