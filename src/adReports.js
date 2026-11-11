import crypto from 'node:crypto';

const COMMAND = /^(?:\/?relat[oó]rio(?:\s+de\s+publicidade)?|\/?comprovantes)$/iu;
const INITIAL = '*Relatório de publicidade — Portal Trivox*\nCapturas automáticas em Linux, Google Chrome com zoom padrão e relógio real.\n\nQual seção você quer no documento Word?\n[1] Topo — três banners\n[2] Meio — dois banners\n\nDigite *1* ou *2*. Para cancelar: *sair*.';
const DOCX_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
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

export function createAdReportFlow({enabled, groupId, authorize, api, sendText, sendDocument,
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
    const session={jid:member.jid,aliases,step:'section'};
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
    await sendText(groupId,'Continue no privado do bot para escolher Topo ou Meio e o período do relatório.');
    return true;
  }
  async function deliver(session) {
    try {
      if (!(await authorize(session.aliases))) throw new Error('Acesso ao grupo não confirmado');
      const query=`section=${session.section}&start=${session.start}&end=${session.end}`;
      const page=await api('/v1/captures?'+query+'&limit=1');
      if (!page.items?.length) {await sendText(session.jid,'Não há capturas dessa seção salvas nesse período.');return;}
      const report=await api('/v1/report.docx?'+query,true);
      const bytes=report.bytes;
      if (!Buffer.isBuffer(bytes)||bytes.length>70_000_000||bytes.subarray(0,4).toString('hex')!=='504b0304'||report.mime!==DOCX_MIME||
          crypto.createHash('sha256').update(bytes).digest('hex')!==report.sha256) throw new Error('O documento não corresponde ao original gerado');
      const label=session.section==='top'?'Topo':'Meio';
      await sendDocument(session.jid,bytes,`PortalTrivox_${label}_${session.start}_a_${session.end}.docx`);
      log({event:'ad_report_document_delivered',count:page.total,section:session.section,start:session.start,end:session.end});
    } catch(error) {
      log({event:'ad_report_failed',message:error.message});
      const text=error.response?.status===413?'O arquivo desse período ficou muito grande. Solicite um intervalo menor.':
        error.response?.status===429?'Outro relatório está em geração. Tente novamente em alguns minutos.':
        'Não foi possível gerar o relatório agora. Tente novamente em alguns minutos.';
      await sendText(session.jid,text);
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
    if (session.step==='section') {
      const value=text.trim().toLocaleLowerCase('pt-BR');
      const section=['1','topo'].includes(value)?'top':['2','meio'].includes(value)?'middle':null;
      if (!section) {await sendText(session.jid,'Escolha *1* para Topo ou *2* para Meio.');return true;}
      session.section=section;session.step='start';remember(session);
      await sendText(session.jid,'Qual é a data inicial? Envie no formato *DD/MM/AAAA*.');return true;
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
