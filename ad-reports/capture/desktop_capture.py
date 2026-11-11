"""Photograph a real X11 desktop. No image compositing and no page-content edits."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

import websocket

SCREEN_WIDTH = 1440
SCREEN_HEIGHT = 1500


class CDP:
    def __init__(self, url):
        self.socket = websocket.create_connection(url, timeout=8, suppress_origin=True)
        self.seq = 0

    def call(self, method, params=None):
        self.seq += 1
        seq = self.seq
        self.socket.send(json.dumps({'id': seq, 'method': method, 'params': params or {}}))
        while True:
            data = json.loads(self.socket.recv())
            if data.get('id') == seq:
                if 'error' in data:
                    raise RuntimeError(data['error']['message'])
                return data.get('result', {})

    def evaluate(self, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True})
        if result.get('exceptionDetails'):
            raise RuntimeError('Falha ao verificar a página pública')
        return result.get('result', {}).get('value')


PAGE_STATE = r"""(() => {
 const visible = (el) => {
   const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
   return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom < innerHeight &&
     s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]');
 };
 const ads = [...document.querySelectorAll('[data-ad-rotator] [data-ad-slide]')].map((a) => {
   const img = a.querySelector('img');
   return {href:a.href, src:img?.currentSrc || img?.src, title:img?.alt || '',
     header:!!a.closest('.header-ad'), loaded:!!img?.complete && img.naturalWidth>0,
     visible:visible(a) && !!img && visible(img)};
 });
 return {url:location.href, title:document.title, heading:document.querySelector('h1')?.textContent || '',
   article_date:document.querySelector('.trivox-hero__overlay small')?.textContent || '',
   ready:document.readyState, ads};
})()"""


def capture(destination):
    children = []
    temp = tempfile.TemporaryDirectory(prefix='trivox-desktop-')
    log = open(Path(destination).with_suffix('.browser.log'), 'w')
    env = {**os.environ, 'DISPLAY': ':99', 'TZ': 'America/Sao_Paulo'}

    def start(args):
        p = subprocess.Popen(args, env=env, stdout=log, stderr=log)
        children.append(p)
        return p

    cdp = None
    try:
        start(['Xvfb', ':99', '-screen', '0', f'{SCREEN_WIDTH}x{SCREEN_HEIGHT}x24', '-nolisten', 'tcp'])
        for _ in range(50):
            if subprocess.run(['xdpyinfo'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.2)
        else:
            raise RuntimeError('Desktop não iniciou')
        start(['openbox', '--config-file', '/home/capture/.config/openbox/rc.xml'])
        time.sleep(.5)
        start(['tint2', '-c', '/home/capture/.config/tint2/tint2rc'])
        # These applications really run in Linux; they are not painted into the image.
        notes=Path(temp.name)/'Notas.txt'
        notes.write_text('')
        editor=start(['mousepad', '--disable-server',str(notes)])
        calculator=start(['galculator'])
        time.sleep(1)
        if editor.poll() is not None or calculator.poll() is not None:
            raise RuntimeError('O editor ou a calculadora não permaneceram abertos')
        chrome = start(['google-chrome-stable', '--test-type', '--no-sandbox', '--no-first-run',
            '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-gpu',
            '--disable-background-networking', '--disable-session-crashed-bubble',
            '--disable-features=Translate,TranslateUI', '--password-store=basic', '--lang=pt-BR',
            '--start-maximized', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222',
            '--user-data-dir=' + temp.name, 'https://portaltrivox.com.br/'])
        deadline = time.monotonic() + 70
        page = None
        while time.monotonic() < deadline:
            if chrome.poll() is not None:
                raise RuntimeError('Google Chrome encerrou antes da captura')
            try:
                with urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=2) as response:
                    pages = json.load(response)
                page = next((p for p in pages if p.get('type') == 'page' and p.get('url', '').startswith('https://portaltrivox.com.br/')), None)
                if page:
                    break
            except Exception:
                pass
            time.sleep(.5)
        if not page:
            raise RuntimeError('Não foi possível verificar o Chrome')
        cdp = CDP(page['webSocketDebuggerUrl'])
        while time.monotonic() < deadline:
            state = cdp.evaluate(PAGE_STATE)
            eligible = state.get('ads', [])
            if state.get('heading') and len(eligible)>0 and all(a['loaded'] and a['visible'] for a in eligible):
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Nem todos os anúncios ficaram carregados e visíveis no desktop; verificar altura da página ou banners em rotação')
        time.sleep(2)
        state = cdp.evaluate(PAGE_STATE)
        matched = state.get('ads',[])
        if not matched or not all(a['visible'] and a['loaded'] for a in matched):
            raise RuntimeError('Uma publicidade saiu de exibição antes da captura; nova tentativa será agendada')
        before = datetime.now(timezone.utc).isoformat()
        subprocess.run(['scrot', str(destination)], env=env, check=True, timeout=10)
        after = datetime.now(timezone.utc).isoformat()
        current = cdp.evaluate(PAGE_STATE)
        if state['url'] != 'https://portaltrivox.com.br/' or not current.get('heading'):
            raise RuntimeError('A página pública não corresponde ao portal esperado')
        if not all(any(a['src']==m['src'] and a['visible'] and a['loaded'] for a in current.get('ads',[])) for m in matched):
            raise RuntimeError('Um anúncio mudou durante a captura; a imagem não será incluída no relatório')
        # Validate the raw PNG header; never alter pixels after capture.
        with open(destination, 'rb') as image:
            header = image.read(24)
        if header[:8] != b'\x89PNG\r\n\x1a\n' or int.from_bytes(header[16:20], 'big') != SCREEN_WIDTH or int.from_bytes(header[20:24], 'big') != SCREEN_HEIGHT:
            raise RuntimeError('Captura PNG inválida')
        version = subprocess.check_output(['google-chrome-stable', '--version'], text=True).strip()
        return {'captured_at_utc': before, 'capture_completed_at_utc': after,
            'browser': version, 'environment': 'Linux, Openbox, tint2; real Mousepad and galculator applications',
            'timezone': 'America/Sao_Paulo', 'desktop_dimensions': [SCREEN_WIDTH, SCREEN_HEIGHT],
            'page': state, 'post_capture_image_edits': False}
    finally:
        if cdp:
            cdp.socket.close()
        for p in reversed(children):
            if p.poll() is None:
                p.terminate()
        for p in reversed(children):
            try:
                p.wait(timeout=4)
            except subprocess.TimeoutExpired:
                p.kill()
        log.close()
        temp.cleanup()


if __name__ == '__main__':
    destination = Path(sys.argv[1])
    try:
        data = capture(destination)
        destination.with_suffix('.json').write_text(json.dumps(data, ensure_ascii=False, indent=2))
        print(json.dumps({'ok': True, 'file': str(destination)}), flush=True)
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}), flush=True)
        sys.exit(1)
