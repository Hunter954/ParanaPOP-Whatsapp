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

TZ = ZoneInfo('America/Sao_Paulo')
ROOT = Path(os.environ.get('CAPTURE_DATA_DIR', '/data'))
TOKEN = os.environ.get('CAPTURE_API_TOKEN', '')
DAILY_COUNT = 1
STOP = threading.Event()
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
          CREATE UNIQUE INDEX IF NOT EXISTS one_capture_per_day ON captures(day);
        ''')
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
        db.execute("UPDATE schedule SET status='done',error=NULL WHERE day IN (SELECT day FROM captures) AND status IN ('pending','running')")


def capture_run(schedule_id=None):
    lockfile = open(ROOT / 'desktop.lock', 'a')
    try:
        fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lockfile.close()
        raise RuntimeError('Já existe uma captura em execução')
    now = datetime.now(TZ)
    with connect() as db:
        if db.execute('SELECT 1 FROM captures WHERE day=? LIMIT 1',(now.date().isoformat(),)).fetchone():
            lockfile.close()
            raise RuntimeError('Já existe uma captura salva neste dia')
    capture_id = uuid.uuid4().hex
    folder = ROOT / 'images' / now.date().isoformat()
    folder.mkdir(exist_ok=True)
    destination = folder / f'{now:%H%M%S}-{capture_id}.png'
    try:
        process = subprocess.Popen(['dbus-run-session', '--', 'python3', '-u',
            str(Path(__file__).with_name('desktop_capture.py')), str(destination)],
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
        metadata = json.loads(destination.with_suffix('.json').read_text())
        captured = datetime.fromisoformat(metadata['captured_at_utc']).astimezone(TZ)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        metadata['sha256'] = digest
        metadata['schedule_id'] = schedule_id
        metadata['captured_at_local'] = captured.isoformat()
        destination.with_suffix('.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        with connect() as db:
            db.execute('INSERT INTO captures VALUES(?,?,?,?,?,?,?,?)', (capture_id,
                schedule_id, captured.date().isoformat(), captured.isoformat(),
                str(destination.relative_to(ROOT)), digest, destination.stat().st_size,
                json.dumps(metadata, ensure_ascii=False)))
        logging.info('capture_saved id=%s captured_at=%s sha256=%s', capture_id, captured.isoformat(), digest)
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
                total = db.execute('SELECT COUNT(*) FROM captures').fetchone()[0]
                latest = db.execute('SELECT captured_at FROM captures ORDER BY captured_at DESC LIMIT 1').fetchone()
                jobs = [dict(row) for row in db.execute('SELECT id,due_at,status,attempts,error FROM schedule WHERE day>=? ORDER BY due_at', (datetime.now(TZ).date().isoformat(),))]
            return self.reply(200, {'count': total, 'latest': latest[0] if latest else None, 'timezone':str(TZ), 'daily_count':DAILY_COUNT, 'schedule':jobs})
        if parsed.path == '/v1/captures':
            query = parse_qs(parsed.query)
            try:
                first, last = parse_range(query.get('start', [''])[0], query.get('end', [''])[0])
                offset = int(query.get('offset', ['0'])[0])
                limit = min(50, max(1, int(query.get('limit', ['50'])[0])))
                if offset < 0:
                    raise ValueError('Página inválida')
            except (ValueError, TypeError) as exc:
                return self.reply(400, {'error':str(exc)})
            with connect() as db:
                count = db.execute('SELECT COUNT(*) FROM captures WHERE day BETWEEN ? AND ?', (first, last)).fetchone()[0]
                rows = db.execute('SELECT id,day,captured_at,sha256 FROM captures WHERE day BETWEEN ? AND ? ORDER BY captured_at,id LIMIT ? OFFSET ?', (first,last,limit,offset)).fetchall()
            items = [{**dict(row), 'date_label':date.fromisoformat(row['day']).strftime('%d/%m/%Y'), 'image_path':f"/v1/images/{row['id']}.png"} for row in rows]
            return self.reply(200, {'items':items, 'total':count, 'next_offset':offset+len(items) if offset+len(items)<count else None})
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
