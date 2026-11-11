import crypto from 'node:crypto';

const COMMAND = /^(?:\/?relat[oó]rio(?:\s+de\s+publicidade)?|\/?comprovantes)$/iu;
const INITIAL = '*Relatório de publicidade — Portal Trivox*\nCapturas automáticas em Linux, com Google Chrome e relógio real.\n\nQual é a data inicial? Envie no formato *DD/MM/AAAA*.\nPara cancelar: *sair*.';
export const normalizeJid = value => String(value || '').replace(/:\d+(?=@)/, '');

export function parseBrazilDate(value, today) {
  const match = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== iso || iso > today) return null;
  return iso;
}

export function todayInBrazil(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'}).format(now);
}

export function createAdReportFlow({enabled, groupId, authorize, api, sendText, sendImage,
  now = () => new Date(), delay = ms => new Promise(resolve => setTimeout(resolve,ms)),
  schedule = task => setImmediate(task), log = () => {}}) {
  const sessions = new Map();
  const processed = new Map();
  const TTL = 30 * 60_000;
  function remember(session) {
    session.updatedAt = now().getTime();
    for (const jid of session.aliases) sessions.set(normalizeJid(jid),session);
  }
  function remove(session) {
    for (const [jid,value] of sessions) if (value===session) sessions.delete(jid);
  }
  function sweep() {
    for (const [id,at] of processed) if (now().getTime()-at>TTL) processed.delete(id);
    for (const session of new Set(sessions.values())) {
      if (session.step!=='sending' && now().getTime()-session.updatedAt>TTL) remove(session);
    }
  }
  async function open(message, candidates) {
    const member = await authorize(candidates);
    if (!member) return null;
    const aliases = [...new Set([member.jid,...(member.aliases||[])].map(normalizeJid))];
    const existing = aliases.map(id=>sessions.get(id)).find(Boolean);
    if (existing?.step==='sending') {
      await sendText(member.jid,'Já existe um relatório em envio para você. Aguarde o término.');
      return existing;
    }
    if (existing) remove(existing);
    const session={jid:member.jid,aliases,step:'start'};
    remember(session);
    await sendText(session.jid,INITIAL);
    return session;
  }
  async function beginFromGroup(message) {
    if (!enabled || message?.key?.fromMe || message?.key?.remoteJid!==groupId) return false;
    const member=await open(message,[message.key.participant,message.key.participantAlt]);
    if (!member) {
      await sendText(groupId,'Não foi possível confirmar seu acesso ao relatório.');
      return true;
    }
    await sendText(groupId,'Continue no privado do bot para escolher as datas do relatório.');
    return true;
  }
  async function deliver(session) {
    let sent=0;
    try {
      let offset=0;
      do {
        if (!(await authorize(session.aliases))) throw new Error('Acesso ao grupo não confirmado');
        const page=await api(`/v1/captures?start=${session.start}&end=${session.end}&offset=${offset}&limit=50`);
        if (!page.items?.length && sent===0) {
          await sendText(session.jid,'Não há capturas salvas nesse período.');
          return;
        }
        for (const item of page.items || []) {
          if (!/^[0-9a-f]{32}$/.test(item.id) || item.image_path!==`/v1/images/${item.id}.png`) throw new Error('Resposta inválida do arquivo de capturas');
          const bytes=await api(item.image_path,true);
          if (!Buffer.isBuffer(bytes) || bytes.length>15_000_000 || crypto.createHash('sha256').update(bytes).digest('hex')!==item.sha256) throw new Error('A imagem não corresponde ao registro original');
          // The report contains photos with only their actual capture date as caption.
          await sendImage(session.jid,bytes,item.date_label);
          sent+=1;
          await delay(450);
        }
        offset=page.next_offset;
      } while(offset!==null && offset!==undefined);
      log({event:'ad_report_delivered',count:sent,start:session.start,end:session.end});
    } catch(error) {
      log({event:'ad_report_failed',count:sent,message:error.message});
      await sendText(session.jid,sent ? 'O envio foi interrompido. Solicite novamente o período para recuperar as imagens.' : 'Não foi possível consultar o relatório agora. Tente novamente em alguns minutos.');
    } finally { remove(session); }
  }
  async function handle(message,text) {
    if (!enabled || message?.key?.fromMe) return false;
    sweep();
    const key=message?.key||{};
    const jid=normalizeJid(key.remoteJid);
    if (jid===groupId) {
      if (COMMAND.test(text.trim())) return beginFromGroup(message);
      return false;
    }
    if (!/@(?:s\.whatsapp\.net|lid)$/.test(jid)) return false;
    const aliases=[jid,key.remoteJidAlt].filter(Boolean).map(normalizeJid);
    const session=aliases.map(id=>sessions.get(id)).find(Boolean);
    if (!session && !COMMAND.test(text.trim())) return false;
    const dedupe=`${jid}:${key.id||''}`;
    if (key.id && processed.has(dedupe)) return true;
    if (key.id) processed.set(dedupe,now().getTime());
    if (session?.step==='sending') return true;
    if (!session || COMMAND.test(text.trim())) {
      if (!(await open(message,aliases))) await sendText(jid,'Este relatório está disponível apenas à equipe do Portal Trivox.');
      return true;
    }
    if (!(await authorize([...aliases,...session.aliases]))) {remove(session);return true;}
    if (/^(?:sair|cancelar|voltar|menu)$/iu.test(text.trim())) {
      remove(session);await sendText(jid,'Relatório encerrado. Para começar novamente, envie *relatório*.');return true;
    }
    const selected=parseBrazilDate(text,todayInBrazil(now()));
    if (!selected) {
      await sendText(session.jid,'Data inválida. Envie uma data existente, sem ser futura, no formato *DD/MM/AAAA*.');return true;
    }
    if (session.step==='start') {
      session.start=selected;session.step='end';remember(session);
      await sendText(session.jid,'Até qual data? Envie a data final no formato *DD/MM/AAAA*.');return true;
    }
    const days=(Date.parse(selected)-Date.parse(session.start))/86400000;
    if(days<0||days>365) {
      await sendText(session.jid,'A data final deve ser igual ou posterior à inicial, em um período de até 366 dias.');return true;
    }
    session.end=selected;session.step='sending';remember(session);
    schedule(()=>deliver(session).catch(error=>log({event:'ad_report_notification_failed',message:error.message})));
    return true;
  }
  return {handle,beginFromGroup};
}
