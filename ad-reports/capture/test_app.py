import hashlib
from http.server import ThreadingHTTPServer
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from unittest.mock import patch

import app


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_root, self.old_token = app.ROOT, app.TOKEN
        app.ROOT, app.TOKEN = pathlib.Path(self.temp.name), 'test-token-with-at-least-thirty-two-characters'
        app.initialize()

    def tearDown(self):
        app.ROOT, app.TOKEN = self.old_root, self.old_token
        self.temp.cleanup()

    def insert_capture(self, day, identifier='a'*32):
        filename = f'images/{identifier}.png'
        data = b'original-test-png-bytes'
        (app.ROOT/filename).write_bytes(data)
        with app.connect() as db:
            db.execute('INSERT INTO captures VALUES(?,?,?,?,?,?,?,?)', (identifier,None,day,
                day+'T23:59:01-03:00',filename,hashlib.sha256(data).hexdigest(),len(data),'{}'))
        return data

    def test_one_real_execution_per_day_and_different_next_day_time(self):
        previous = None
        for index in range(800):
            day = date(2026,1,1)+timedelta(days=index)
            times = app.daily_times(day)
            self.assertEqual(len(times),1)
            self.assertEqual(times,app.daily_times(day))
            self.assertEqual(times[0].date(),day)
            self.assertEqual(str(times[0].tzinfo),'America/Sao_Paulo')
            self.assertNotEqual(times[0].minute%5,0)
            self.assertNotEqual(times[0].strftime('%H:%M'),previous)
            previous = times[0].strftime('%H:%M')

    def test_restart_does_not_capture_again_or_fabricate_past_days(self):
        today = datetime.now(app.TZ)
        self.insert_capture(today.date().isoformat())
        with app.connect() as db:
            db.execute('INSERT INTO schedule(id,day,due_at,status) VALUES(?,?,?,?)',
                ('old',(today.date()-timedelta(days=1)).isoformat(),today.isoformat(),'pending'))
        app.ensure_schedule(today)
        with app.connect() as db:
            self.assertEqual(db.execute("SELECT status FROM schedule WHERE id='old'").fetchone()[0],'missed')
            self.assertEqual(db.execute('SELECT status FROM schedule WHERE day=?',(today.date().isoformat(),)).fetchone()[0],'done')
        with patch.object(app.subprocess,'Popen',side_effect=AssertionError('must not launch browser')):
            with self.assertRaisesRegex(RuntimeError,'Já existe'):
                app.capture_run()

    def test_dates_reject_impossible_reversed_and_future_ranges(self):
        for values in [('2026-02-30','2026-03-01'),('2026-11-10','2026-11-09'),('2099-01-01','2099-01-02'),('../','2026-11-01')]:
            with self.assertRaises(ValueError): app.parse_range(*values)

    def test_private_api_auth_inclusive_dates_and_safe_image_paths(self):
        day = datetime.now(app.TZ).date().isoformat()
        original = self.insert_capture(day)
        server = ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        def request(route, auth=True):
            req=urllib.request.Request(base+route,headers={'Authorization':'Bearer '+app.TOKEN} if auth else {})
            return urllib.request.urlopen(req,timeout=3)
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                request('/v1/images/'+'a'*32+'.png',False)
            self.assertEqual(error.exception.code,401)
            with request(f'/v1/captures?start={day}&end={day}') as response:
                report=json.load(response)
            self.assertEqual(report['total'],1)
            self.assertEqual(report['items'][0]['date_label'],datetime.fromisoformat(day).strftime('%d/%m/%Y'))
            with request(report['items'][0]['image_path']) as response:
                self.assertEqual(response.read(),original)
            for route in ['/v1/images/../captures.sqlite3','/v1/images/'+'b'*32+'.png']:
                with self.assertRaises(urllib.error.HTTPError) as error: request(route)
                self.assertEqual(error.exception.code,404)
        finally:
            server.shutdown();server.server_close();thread.join()


if __name__=='__main__': unittest.main()
