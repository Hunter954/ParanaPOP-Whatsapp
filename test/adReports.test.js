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
    sendText:async(jid,text,mentions)=>texts.push({jid,text,mentions}),
    sendDocument:async(jid,bytes,fileName)=>documents.push({jid,bytes,fileName}),
    now:()=>new Date('2026-11-11T16:00:00Z'),delay:async()=>{},schedule:task=>tasks.push(task),...options});
  return {flow,texts,documents,tasks,queries};
}

test('Brazil date parsing checks real calendar dates and the Brazil midnight boundary',()=>{
  assert.equal(todayInBrazil(new Date('2026-11-12T01:30:00Z')),'2026-11-11');
  assert.equal(parseBrazilDate('29/02/2024','2026-11-11'),'2024-02-29');
  for(const date of ['29/02/2026','31/04/2026','1/11/2026','12/11/2026']) assert.equal(parseBrazilDate(date,'2026-11-11'),null);
});

test('group entry asks every question in the group and sends one Word document there without extra messages',async()=>{
  const {flow,texts,documents,tasks,queries}=fixture();
  const start=message(group,{participant:lid,participantAlt:user});
  await flow.beginFromGroup(start);await flow.beginFromGroup(start);
  assert.equal(texts.length,1);assert.match(texts[0].text,/Qual seção/);
  assert.equal(texts[0].jid,group);assert.deepEqual(texts[0].mentions,[user]);
  await flow.handle(message(group,{participant:lid,participantAlt:user}),'1');
  assert.match(texts.at(-1).text,/data inicial/);
  await flow.handle(message(group,{participant:user}),'10/11/2026');
  assert.match(texts.at(-1).text,/data final/);
  assert(texts.every(entry=>entry.jid===group));
  const textCount=texts.length;
  const end=message(group,{participant:lid,participantAlt:user});
  await flow.handle(end,'11/11/2026');
  await flow.handle(end,'11/11/2026');
  assert.equal(tasks.length,1);
  await tasks.shift()();
  assert.equal(texts.length,textCount);
  assert.equal(documents.length,1);assert.equal(documents[0].jid,group);
  assert.equal(documents[0].fileName,'PortalTrivox_Topo_2026-11-10_a_2026-11-11.docx');
  assert(queries.every(q=>q.includes('section=top')));
});

test('simultaneous group requests belong to each sender and private replies cannot advance them',async()=>{
  const second='550000000002@s.whatsapp.net';
  const {flow,texts,tasks,documents}=fixture({authorize:async candidates=>{
    if(candidates.includes(second))return {jid:second,aliases:[second]};
    return candidates.some(id=>[user,lid].includes(id))?{jid:user,aliases:[user,lid]}:null;
  }});
  const input=(participant,text)=>flow.handle(message(group,{participant}),text);
  await input(user,'relatório');
  const before=texts.length;
  assert.equal(await input(second,'2'),false);
  assert.equal(await flow.handle(message(user),'1'),false);
  assert.equal(await flow.handle(message('120363000000000000@g.us',{participant:user}),'1'),false);
  assert.equal(texts.length,before);
  await input(second,'relatório');
  await input(user,'1');await input(second,'2');
  await input(second,'11/11/2026');await input(user,'10/11/2026');
  await input(user,'11/11/2026');await input(second,'11/11/2026');
  assert.equal(tasks.length,2);
  for(const task of tasks)await task();
  assert.deepEqual(documents.map(doc=>doc.fileName),[
    'PortalTrivox_Topo_2026-11-10_a_2026-11-11.docx',
    'PortalTrivox_Meio_2026-11-11_a_2026-11-11.docx']);
  assert(texts.every(entry=>entry.jid===group));assert(documents.every(doc=>doc.jid===group));
});

test('menu releases a group report session and expired sessions ignore further replies',async()=>{
  let clock=new Date('2026-11-11T16:00:00Z');
  const {flow,texts}=fixture({now:()=>clock});
  const input=text=>flow.handle(message(group,{participant:user}),text);
  await input('relatório');assert.equal(await input('menu'),false);
  assert.equal(await input('1'),false);
  await input('relatório');clock=new Date('2026-11-11T16:31:00Z');
  const before=texts.length;assert.equal(await input('1'),false);assert.equal(texts.length,before);
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

test('report menu appears only for Trivox and option 9 starts the group flow',async()=>{
  const replies=[];let starts=0;
  const config={adminMenuEnabled:true,adminMenuGroupId:group,adminMenuApiUrl:'http://unused',adminMenuToken:'test',adminMenuBrandName:'Portal Trivox',adminMenuHasAdReports:true};
  const input={message:message(group,{participant:user}),config,remoteJid:group,participant:user,reply:async text=>replies.push(text),startAdReportFlow:async()=>{starts++;}};
  await handleAdminMenu({...input,text:'menu'});assert.match(replies.at(-1),/\[9\] Relatório de publicidade/);
  await handleAdminMenu({...input,text:'9'});assert.equal(starts,1);
  await handleAdminMenu({...input,config:{...config,adminMenuHasAdReports:false},text:'menu'});assert.doesNotMatch(replies.at(-1),/\[9\]/);
});
