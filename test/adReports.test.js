import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createAdReportFlow,parseBrazilDate,todayInBrazil} from '../src/adReports.js';
import {handleAdminMenu} from '../src/adminMenu.js';

const group='120363427834388908@g.us';
const user='550000000001@s.whatsapp.net';
const lid='900000000001@lid';
let seq=0;
const message=(jid=user,extra={})=>({key:{remoteJid:jid,id:String(++seq),...extra}});

function fixture(options={}) {
  const texts=[],documents=[],tasks=[],queries=[];
  const bytes=Buffer.concat([Buffer.from('504b0304','hex'),Buffer.from('test-document')]);
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  const entries=[{id:'a'.repeat(32),date_label:'10/11/2026',image_path:'/v1/images/'+ 'a'.repeat(32)+'.png',sha256:digest},
    {id:'b'.repeat(32),date_label:'11/11/2026',image_path:'/v1/images/'+ 'b'.repeat(32)+'.png',sha256:digest}];
  const flow=createAdReportFlow({enabled:true,groupId:group,
    authorize:async candidates=>candidates.some(id=>[user,lid].includes(id))?{jid:user,aliases:[user,lid]}:null,
    api:async (route,binary)=>{queries.push(route);return binary?{bytes,sha256:digest,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}:{items:entries,total:2,next_offset:null};},
    sendText:async(jid,text)=>texts.push({jid,text}),
    sendDocument:async(jid,bytes,fileName)=>documents.push({jid,bytes,fileName}),
    now:()=>new Date('2026-11-11T16:00:00Z'),delay:async()=>{},schedule:task=>tasks.push(task),...options});
  return {flow,texts,documents,tasks,queries};
}

test('Brazil date parsing checks real calendar dates and the Brazil midnight boundary',()=>{
  assert.equal(todayInBrazil(new Date('2026-11-12T01:30:00Z')),'2026-11-11');
  assert.equal(parseBrazilDate('29/02/2024','2026-11-11'),'2024-02-29');
  for(const date of ['29/02/2026','31/04/2026','1/11/2026','12/11/2026']) assert.equal(parseBrazilDate(date,'2026-11-11'),null);
});

test('group entry asks the section and dates privately and sends one Word document without extra messages',async()=>{
  const {flow,texts,documents,tasks,queries}=fixture();
  await flow.beginFromGroup(message(group,{participant:lid,participantAlt:user}));
  assert.match(texts[0].text,/Qual seção/);assert.equal(texts[0].jid,user);
  assert.equal(texts[1].jid,group);
  await flow.handle(message(lid,{remoteJidAlt:user}),'1');
  assert.match(texts.at(-1).text,/data inicial/);
  await flow.handle(message(lid,{remoteJidAlt:user}),'10/11/2026');
  assert.match(texts.at(-1).text,/data final/);
  const textCount=texts.length;
  const end=message(user);
  await flow.handle(end,'11/11/2026');
  await flow.handle(end,'11/11/2026');
  assert.equal(tasks.length,1);
  await tasks.shift()();
  assert.equal(texts.length,textCount);
  assert.equal(documents.length,1);assert.equal(documents[0].jid,user);
  assert.equal(documents[0].fileName,'PortalTrivox_Topo_2026-11-10_a_2026-11-11.docx');
  assert(queries.every(q=>q.includes('section=top')));
});

test('unknown private requester cannot obtain reports and fromMe does not start a flow',async()=>{
  const {flow,documents,tasks}=fixture();
  await flow.handle(message('550000000009@s.whatsapp.net'),'relatório');
  assert.equal(await flow.handle(message(user,{fromMe:true}),'relatório'),false);
  assert.equal(tasks.length,0);assert.equal(documents.length,0);
});

test('invalid and reversed dates do not submit a report',async()=>{
  const {flow,tasks,texts}=fixture();
  await flow.handle(message(),'relatório');
  await flow.handle(message(),'1');
  await flow.handle(message(),'31/02/2026');
  assert.match(texts.at(-1).text,/inválida/);
  await flow.handle(message(),'11/11/2026');
  await flow.handle(message(),'10/11/2026');
  assert.match(texts.at(-1).text,/posterior/);assert.equal(tasks.length,0);
});

test('damaged document is rejected before sending a file',async()=>{
  const {flow,tasks,documents,texts}=fixture({api:async(route,binary)=>binary?{bytes:Buffer.from('corrupt'),sha256:'0'.repeat(64),mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}:
    {items:[{id:'a'.repeat(32),image_path:'/v1/images/'+'a'.repeat(32)+'.png',sha256:'0'.repeat(64),date_label:'11/11/2026'}],next_offset:null}});
  await flow.handle(message(),'relatório');await flow.handle(message(),'1');await flow.handle(message(),'11/11/2026');await flow.handle(message(),'11/11/2026');
  await tasks.shift()();assert.equal(documents.length,0);assert.match(texts.at(-1).text,/Não foi possível/);
});

test('middle selection filters every archive request and labels the file correctly',async()=>{
  const {flow,texts,tasks,documents,queries}=fixture();
  await flow.handle(message(),'relatório');await flow.handle(message(),'3');
  assert.match(texts.at(-1).text,/Escolha/);
  await flow.handle(message(),'meio');await flow.handle(message(),'11/11/2026');await flow.handle(message(),'11/11/2026');
  await tasks.shift()();assert(queries.every(q=>q.includes('section=middle')));
  assert.equal(documents[0].fileName,'PortalTrivox_Meio_2026-11-11_a_2026-11-11.docx');
});

test('report menu appears only for Trivox and option 9 starts the private flow',async()=>{
  const replies=[];let starts=0;
  const config={adminMenuEnabled:true,adminMenuGroupId:group,adminMenuApiUrl:'http://unused',adminMenuToken:'test',adminMenuBrandName:'Portal Trivox',adminMenuHasAdReports:true};
  const input={message:message(group,{participant:user}),config,remoteJid:group,participant:user,reply:async text=>replies.push(text),startAdReportFlow:async()=>{starts++;}};
  await handleAdminMenu({...input,text:'menu'});assert.match(replies.at(-1),/\[9\] Relatório de publicidade/);
  await handleAdminMenu({...input,text:'9'});assert.equal(starts,1);
  await handleAdminMenu({...input,config:{...config,adminMenuHasAdReports:false},text:'menu'});assert.doesNotMatch(replies.at(-1),/\[9\]/);
});
