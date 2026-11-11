"""Capture the top and middle of the live portal at the browser's default zoom."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

from desktop_capture import CDP

WIDTH, HEIGHT = 1920, 1080
STATE = r"""(() => {
 const visible = (el) => {const r=el.getBoundingClientRect(),s=getComputedStyle(el);
   return r.width>0&&r.height>0&&r.top>=0&&r.bottom<innerHeight&&s.visibility!=='hidden'&&s.display!=='none'&&!el.closest('[hidden]');};
 const ads=[...document.querySelectorAll('[data-ad-rotator] [data-ad-slide]')].map(a=>{
   const img=a.querySelector('img'),r=a.getBoundingClientRect();
   return {href:a.href,src:img?.currentSrc||img?.src,title:img?.alt||'',
     section:a.closest('.header-ad,.trivox-ad-stack')?'top':a.closest('.home-ad-pair')?'middle':'other',
     loaded:!!img?.complete&&img.naturalWidth>0,visible:visible(a)&&!!img&&visible(img),
     top:r.top+scrollY,bottom:r.bottom+scrollY};});
 const date=document.querySelector('.trivox-hero__overlay small');
 return {url:location.href,title:document.title,heading:document.querySelector('h1')?.textContent||'',
   article_date:date?.textContent||'',article_date_visible:!!date&&visible(date),
   scroll_y:scrollY,viewport_height:innerHeight,viewport_width:innerWidth,
   device_pixel_ratio:devicePixelRatio,visual_scale:visualViewport?.scale||1,ads};
})()"""


def capture_pair(destination):
    children=[]
    profile=tempfile.TemporaryDirectory(prefix='trivox-desktop-')
    logfile=open(destination.with_suffix('.browser.log'),'w')
    env={**os.environ,'DISPLAY':':99','TZ':'America/Sao_Paulo'}
    cdp=None

    def start(args):
        p=subprocess.Popen(args,env=env,stdout=logfile,stderr=logfile);children.append(p);return p

    try:
        start(['Xvfb',':99','-screen','0',f'{WIDTH}x{HEIGHT}x24','-nolisten','tcp'])
        for _ in range(50):
            if subprocess.run(['xdpyinfo'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
            time.sleep(.2)
        else:raise RuntimeError('Desktop não iniciou')
        start(['openbox','--config-file','/home/capture/.config/openbox/rc.xml']);time.sleep(.5)
        start(['tint2','-c','/home/capture/.config/tint2/tint2rc'])
        notes=Path.home()/'Documents'/'Notas.txt';notes.parent.mkdir(exist_ok=True);notes.write_text('')
        editor=start(['mousepad','--disable-server',str(notes)]);calculator=start(['galculator']);time.sleep(1)
        if editor.poll() is not None or calculator.poll() is not None:raise RuntimeError('O editor ou a calculadora encerrou')
        browser=start(['google-chrome-stable','--test-type','--no-sandbox','--no-first-run',
            '--no-default-browser-check','--disable-dev-shm-usage','--disable-gpu','--disable-background-networking',
            '--disable-session-crashed-bubble','--disable-features=Translate,TranslateUI','--password-store=basic',
            '--lang=pt-BR','--force-device-scale-factor=1','--start-maximized',
            '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222',
            '--user-data-dir='+profile.name,'https://portaltrivox.com.br/'])
        deadline=time.monotonic()+75
        page=None
        while time.monotonic()<deadline:
            if browser.poll() is not None:raise RuntimeError('Google Chrome encerrou')
            try:
                with urllib.request.urlopen('http://127.0.0.1:9222/json/list',timeout=2) as r:pages=json.load(r)
                page=next((p for p in pages if p.get('type')=='page' and p.get('url','').startswith('https://portaltrivox.com.br/')),None)
                if page:break
            except Exception:pass
            time.sleep(.5)
        if not page:raise RuntimeError('Não foi possível verificar o Chrome')
        cdp=CDP(page['webSocketDebuggerUrl'])
        results=[]
        for section,expected in [('top',3),('middle',2)]:
            while time.monotonic()<deadline:
                state=cdp.evaluate(STATE)
                target=[a for a in state['ads'] if a['section']==section]
                if section=='middle' and target:
                    center=(min(a['top'] for a in target)+max(a['bottom'] for a in target))/2
                    wanted=max(0,center-state['viewport_height']/2)
                    delta=wanted-state['scroll_y']
                    if abs(delta)>8:
                        cdp.call('Input.dispatchMouseEvent',{'type':'mouseWheel','x':state['viewport_width']/2,
                            'y':state['viewport_height']/2,'deltaX':0,'deltaY':delta})
                        time.sleep(.6);continue
                if state['heading'] and len(target)==expected and all(a['visible'] and a['loaded'] for a in target):break
                time.sleep(.4)
            else:raise RuntimeError('Os banners da seção '+section+' não ficaram completamente visíveis')
            time.sleep(.7)
            state=cdp.evaluate(STATE);target=[a for a in state['ads'] if a['section']==section]
            if len(target)!=expected or not all(a['visible'] and a['loaded'] for a in target):raise RuntimeError('Publicidade mudou antes da captura')
            if state['url']!='https://portaltrivox.com.br/' or abs(state['device_pixel_ratio']-1)>.01 or abs(state['visual_scale']-1)>.01:
                raise RuntimeError('A página ou o zoom padrão não corresponde ao esperado')
            before=datetime.now(timezone.utc).isoformat()
            image=destination.with_name(destination.stem+'-'+section+'.png')
            subprocess.run(['scrot',str(image)],env=env,check=True,timeout=10)
            after=datetime.now(timezone.utc).isoformat();current=cdp.evaluate(STATE)
            if not all(any(a['src']==m['src'] and a['visible'] and a['loaded'] for a in current['ads']) for m in target):
                raise RuntimeError('A publicidade mudou durante a captura')
            with open(image,'rb') as f:header=f.read(24)
            if header[:8]!=b'\x89PNG\r\n\x1a\n' or int.from_bytes(header[16:20],'big')!=WIDTH or int.from_bytes(header[20:24],'big')!=HEIGHT:
                raise RuntimeError('Captura PNG inválida')
            metadata={'section':section,'captured_at_utc':before,'capture_completed_at_utc':after,
                'browser':subprocess.check_output(['google-chrome-stable','--version'],text=True).strip(),
                'environment':'Linux Openbox tint2 Mousepad galculator','timezone':'America/Sao_Paulo',
                'desktop_dimensions':[WIDTH,HEIGHT],'zoom_percent':100,'page':state,
                'visible_ad_count':len(target),'post_capture_image_edits':False}
            image.with_suffix('.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
            results.append({'section':section,'filename':str(image),'metadata':metadata})
        return {'captures':results}
    finally:
        if cdp:cdp.socket.close()
        for p in reversed(children):
            if p.poll() is None:p.terminate()
        for p in reversed(children):
            try:p.wait(timeout=4)
            except subprocess.TimeoutExpired:p.kill()
        logfile.close();profile.cleanup()


if __name__=='__main__':
    dest=Path(sys.argv[1])
    try:
        manifest=capture_pair(dest)
        dest.with_suffix('.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
        print(json.dumps({'ok':True,'sections':[x['section'] for x in manifest['captures']]}),flush=True)
    except Exception as exc:
        print(json.dumps({'ok':False,'error':str(exc)}),flush=True);sys.exit(1)
