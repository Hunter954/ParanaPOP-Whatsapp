"""Persistent daily capture schedule and private read-only report API."""
from datetime import date, datetime, time as dt_time, timedelta, timezone
import fcntl
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import random
import re
import signal
import sqlite3
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid
from zoneinfo import ZoneInfo
from report_docx import build_report, MIME

TZ = ZoneInfo('America/Sao_Paulo')
ROOT = Path(os.environ.get('CAPTURE_DATA_DIR', '/data'))
TOKEN = os.environ.get('CAPTURE_API_TOKEN', '')
DAILY_COUNT = 1
STOP = threading.Event()
REPORT_LOCK = threading.Lock()
REPORT_LAYOUT_HASH = hashlib.sha256(Path(__file__).with_name('report_docx.py').read_bytes()).hexdigest()
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')


def connect():
    conn = sqlite3.connect(ROOT / 'captures.sqlite3', timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def initialize():
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / 'images').mkdir(exist_ok=True)
    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
          CREATE TABLE IF NOT EXISTS schedule (
            id TEXT PRIMARY KEY, day TEXT NOT NULL, due_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            retry_at TEXT, error TEXT, updated_at TEXT);
          CREATE TABLE IF NOT EXISTS captures (
            id TEXT PRIMARY KEY, schedule_id TEXT, day TEXT NOT NULL,
            captured_at TEXT NOT NULL, filename TEXT NOT NULL UNIQUE,
            sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, metadata TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS captures_dates ON captures(day, captured_at, id);
        ''')
        columns={row[1] for row in db.execute('PRAGMA table_info(captures)')}
        if 'section' not in columns:
            db.execute("ALTER TABLE captures ADD COLUMN section TEXT NOT NULL DEFAULT 'legacy'")
        db.execute('DROP INDEX IF EXISTS one_capture_per_day')
        db.execute('CREATE UNIQUE INDEX IF NOT EXISTS one_capture_per_day_section ON captures(day,section)')
        # A terminated process must not leave a schedule permanently claimed.
        db.execute("UPDATE schedule SET status='pending' WHERE status='running'")


def daily_times(day, count=DAILY_COUNT):
    """Stable, varied real execution times; never used to backdate a screenshot."""
    rng = random.Random('portaltrivox-daily-v1:' + day.isoformat())
    # The hour cycles across the working day and differs on consecutive days;
    # minutes vary by date. There is exactly one capture slot per calendar day.
    hour = 8 + (day.toordinal() * 7 % 10)
    windows = [(hour, hour+1)]
    result = []
    for low, high in windows:
        # Non-round minutes distribute the jobs within the day's windows.
        hour = rng.randrange(low, high)
        minute = rng.choice([m for m in range(1, 60) if m % 5])
        result.append(datetime.combine(day, dt_time(hour, minute), TZ))
    return sorted(result)


def ensure_schedule(now):
    with connect() as db:
        for day in (now.date(), now.date() + timedelta(days=1)):
            for index, due in enumerate(daily_times(day)):
                db.execute('INSERT OR IGNORE INTO schedule(id,day,due_at) VALUES(?,?,?)',
                    (f'{day.isoformat()}-{index}', day.isoformat(), due.isoformat()))
        # Missed past days remain documented, never recreated with old timestamps.
        db.execute("UPDATE schedule SET status='missed', error='Serviço indisponível neste dia' WHERE day < ? AND status='pending'", (now.date().isoformat(),))
        complete="SELECT day FROM captures WHERE section IN ('top','middle') GROUP BY day HAVING COUNT(DISTINCT section)=2"
        db.execute("UPDATE schedule SET status='pending',attempts=0 WHERE day>=? AND status='done' AND day NOT IN ("+complete+")",(now.date().isoformat(),))
        db.execute("UPDATE schedule SET status='done',error=NULL WHERE day IN ("+complete+") AND status IN ('pending','running')")


def capture_run(schedule_id=None):
    lockfile = open(ROOT / 'desktop.lock', 'a')
    try:
        fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lockfile.close()
        raise RuntimeError('Já existe uma captura em execução')
    now = datetime.now(TZ)
    with connect() as db:
        existing={r[0] for r in db.execute("SELECT section FROM captures WHERE day=? AND section IN ('top','middle')",(now.date().isoformat(),))}
        if existing=={'top','middle'}:
            lockfile.close()
            raise RuntimeError('Já existem as duas capturas salvas neste dia')
    capture_id = uuid.uuid4().hex
    folder = ROOT / 'images' / now.date().isoformat()
    folder.mkdir(exist_ok=True)
    destination = folder / f'{now:%H%M%S}-{capture_id}.png'
    try:
        process = subprocess.Popen(['dbus-run-session', '--', 'python3', '-u',
            str(Path(__file__).with_name('desktop_sections.py')), str(destination)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=6)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise RuntimeError('Tempo limite da captura excedido')
        if process.returncode:
            raise RuntimeError((stdout or stderr)[-500:])
        manifest = json.loads(destination.with_suffix('.json').read_text())
        if {item['section'] for item in manifest['captures']}!={'top','middle'}:
            raise RuntimeError('O lote não contém as duas seções')
        records=[]
        for item in manifest['captures']:
            metadata=item['metadata'];image=Path(item['filename'])
            if not image.resolve().is_relative_to(folder.resolve()):raise RuntimeError('Caminho de captura inválido')
            captured=datetime.fromisoformat(metadata['captured_at_utc']).astimezone(TZ)
            if captured.date()!=now.date():raise RuntimeError('A captura atravessou a mudança de dia')
            digest=hashlib.sha256(image.read_bytes()).hexdigest()
            metadata.update(sha256=digest,schedule_id=schedule_id,batch_id=capture_id,captured_at_local=captured.isoformat())
            image.with_suffix('.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
            if item['section'] not in existing:
                records.append((uuid.uuid4().hex,schedule_id,captured.date().isoformat(),captured.isoformat(),
                    str(image.relative_to(ROOT)),digest,image.stat().st_size,json.dumps(metadata,ensure_ascii=False),item['section']))
        with connect() as db:
            db.executemany('INSERT INTO captures(id,schedule_id,day,captured_at,filename,sha256,bytes,metadata,section) VALUES(?,?,?,?,?,?,?,?,?)',records)
        logging.info('capture_pair_saved batch=%s sections=%s',capture_id,','.join(r[-1] for r in records))
        return capture_id
    finally:
        fcntl.flock(lockfile, fcntl.LOCK_UN)
        lockfile.close()


def scheduler():
    while not STOP.is_set():
        try:
            now = datetime.now(TZ)
            ensure_schedule(now)
            # At most one catch-up screenshot per startup/iteration: it keeps today's
            # actual time and the other missed slots are marked, not backfilled.
            with connect() as db:
                due = db.execute("SELECT * FROM schedule WHERE day=? AND status='pending' AND due_at<=? AND (retry_at IS NULL OR retry_at<=?) ORDER BY due_at DESC",
                    (now.date().isoformat(), now.isoformat(), now.isoformat())).fetchall()
                selected = due[0] if due else None
                if selected:
                    for old in due[1:]:
                        db.execute("UPDATE schedule SET status='missed', error='Horário anterior perdido; mantida somente a recuperação atual' WHERE id=?", (old['id'],))
                    db.execute("UPDATE schedule SET status='running',attempts=attempts+1,updated_at=? WHERE id=?", (now.isoformat(), selected['id']))
            if selected:
                try:
                    capture_run(selected['id'])
                    with connect() as db:
                        db.execute("UPDATE schedule SET status='done', error=NULL, updated_at=? WHERE id=?", (datetime.now(TZ).isoformat(), selected['id']))
                except Exception as exc:
                    attempts = selected['attempts'] + 1
                    with connect() as db:
                        db.execute('UPDATE schedule SET status=?, retry_at=?, error=?, updated_at=? WHERE id=?',
                            ('failed' if attempts >= 3 else 'pending', (now + timedelta(minutes=15)).isoformat(), str(exc)[-500:], now.isoformat(), selected['id']))
                    logging.error('capture_failed schedule=%s error=%s', selected['id'], str(exc)[-500:])
        except Exception:
            logging.exception('scheduler_iteration_failed')
        STOP.wait(20)


def parse_range(start, end):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', start or '') or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', end or ''):
        raise ValueError('Datas inválidas')
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    if first > last or last > datetime.now(TZ).date() or (last - first).days > 365:
        raise ValueError('Informe um período válido de até 366 dias, sem datas futuras')
    return first.isoformat(), last.isoformat()


class Handler(BaseHTTPRequestHandler):
    server_version = 'TrivoxCaptures/1'

    def log_message(self, fmt, *args):
        # Do not log credentials, request bodies, or query strings.
        logging.info('api method=%s status=%s', self.command, args[1] if len(args) > 1 else '-')

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        given = self.headers.get('Authorization', '')
        return bool(TOKEN) and hmac.compare_digest(given, 'Bearer ' + TOKEN)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == '/health':
            return self.reply(200, {'ok': True, 'service': 'trivox-ad-captures'})
        if not self.authorized():
            return self.reply(401, {'error': 'unauthorized'})
        if parsed.path == '/v1/status':
            with connect() as db:
                total = db.execute("SELECT COUNT(*) FROM captures WHERE section IN ('top','middle')").fetchone()[0]
                latest = db.execute("SELECT captured_at FROM captures WHERE section IN ('top','middle') ORDER BY captured_at DESC LIMIT 1").fetchone()
                sections={r[0]:r[1] for r in db.execute('SELECT section,COUNT(*) FROM captures GROUP BY section')}
                jobs = [dict(row) for row in db.execute('SELECT id,due_at,status,attempts,error FROM schedule WHERE day>=? ORDER BY due_at', (datetime.now(TZ).date().isoformat(),))]
            return self.reply(200, {'count': total, 'latest': latest[0] if latest else None, 'timezone':str(TZ), 'daily_count':DAILY_COUNT,'photos_per_day':2,'sections':sections,'schedule':jobs})
        if parsed.path == '/v1/captures':
            query = parse_qs(parsed.query)
            try:
                first, last = parse_range(query.get('start', [''])[0], query.get('end', [''])[0])
                section=query.get('section',['legacy'])[0]
                if section not in ('legacy','top','middle'):raise ValueError('Seção inválida')
                offset = int(query.get('offset', ['0'])[0])
                limit = min(50, max(1, int(query.get('limit', ['50'])[0])))
                if offset < 0:
                    raise ValueError('Página inválida')
            except (ValueError, TypeError) as exc:
                return self.reply(400, {'error':str(exc)})
            with connect() as db:
                count = db.execute('SELECT COUNT(*) FROM captures WHERE day BETWEEN ? AND ? AND section=?', (first, last,section)).fetchone()[0]
                rows = db.execute('SELECT id,day,captured_at,sha256,section FROM captures WHERE day BETWEEN ? AND ? AND section=? ORDER BY captured_at,id LIMIT ? OFFSET ?', (first,last,section,limit,offset)).fetchall()
            items = [{**dict(row), 'date_label':date.fromisoformat(row['day']).strftime('%d/%m/%Y'), 'image_path':f"/v1/images/{row['id']}.png"} for row in rows]
            return self.reply(200, {'items':items, 'total':count, 'next_offset':offset+len(items) if offset+len(items)<count else None})
        if parsed.path=='/v1/report.docx':
            query=parse_qs(parsed.query)
            try:
                first,last=parse_range(query.get('start',[''])[0],query.get('end',[''])[0])
                section=query.get('section',[''])[0]
                if section not in ('top','middle'):raise ValueError('Escolha Topo ou Meio')
            except ValueError as exc:return self.reply(400,{'error':str(exc)})
            with connect() as db:
                rows=[dict(r) for r in db.execute('SELECT * FROM captures WHERE day BETWEEN ? AND ? AND section=? ORDER BY captured_at,id',(first,last,section))]
            if not rows:return self.reply(404,{'error':'no_captures'})
            if sum(r['bytes'] for r in rows)>60_000_000:return self.reply(413,{'error':'report_too_large'})
            if not REPORT_LOCK.acquire(blocking=False):return self.reply(429,{'error':'report_busy'})
            try:
                key=hashlib.sha256(json.dumps([REPORT_LAYOUT_HASH,section,first,last,[(r['id'],r['sha256']) for r in rows]]).encode()).hexdigest()
                folder=ROOT/'reports';folder.mkdir(exist_ok=True)
                target=folder/(key+'.docx')
                if not target.exists():
                    temporary=folder/(key+'-'+uuid.uuid4().hex+'.tmp.docx')
                    build_report(ROOT,rows,section,first,last,temporary)
                    temporary.replace(target)
                digest=hashlib.sha256(target.read_bytes()).hexdigest()
                label='Topo' if section=='top' else 'Meio'
                self.send_response(200);self.send_header('Content-Type',MIME)
                self.send_header('Content-Length',str(target.stat().st_size))
                self.send_header('Content-Disposition',f'attachment; filename="PortalTrivox_{label}_{first}_a_{last}.docx"')
                self.send_header('X-Report-SHA256',digest);self.send_header('Cache-Control','private, no-store');self.end_headers()
                with open(target,'rb') as f:
                    while block:=f.read(65536):self.wfile.write(block)
            except (ValueError,OSError):
                logging.exception('report_generation_failed')
                if not self.wfile.closed:self.reply(500,{'error':'report_generation_failed'})
            finally:REPORT_LOCK.release()
            return
        match = re.fullmatch(r'/v1/images/([0-9a-f]{32})\.png', parsed.path)
        if match:
            with connect() as db:
                row = db.execute('SELECT filename,sha256,bytes FROM captures WHERE id=?', (match[1],)).fetchone()
            if not row:
                return self.reply(404, {'error':'not_found'})
            image = (ROOT / row['filename']).resolve()
            if not image.is_relative_to(ROOT.resolve()) or not image.is_file():
                return self.reply(404, {'error':'not_found'})
            self.send_response(200)
            self.send_header('Content-Type','image/png')
            self.send_header('Content-Length',str(row['bytes']))
            self.send_header('ETag','"' + row['sha256'] + '"')
            self.send_header('Cache-Control','private, no-store')
            self.end_headers()
            with open(image,'rb') as file:
                while block := file.read(65536):
                    self.wfile.write(block)
            return
        self.reply(404, {'error':'not_found'})


if __name__ == '__main__':
    if len(TOKEN) < 32:
        raise SystemExit('CAPTURE_API_TOKEN precisa ter pelo menos 32 caracteres')
    initialize()
    thread = threading.Thread(target=scheduler, daemon=True)
    thread.start()
    server = ThreadingHTTPServer(('0.0.0.0',8090),Handler)
    signal.signal(signal.SIGTERM, lambda *_: (STOP.set(), threading.Thread(target=server.shutdown,daemon=True).start()))
    logging.info('service_started timezone=%s daily_count=%d', TZ,DAILY_COUNT)
    try:
        server.serve_forever()
    finally:
        STOP.set()
        thread.join(timeout=125)
