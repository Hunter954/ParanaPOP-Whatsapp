import hashlib
from http.server import ThreadingHTTPServer
import io
import json
from pathlib import Path
import sqlite3
import struct
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
import zipfile
import zlib
from datetime import datetime,timedelta

import app
from report_docx import MIME


def png(rgb):
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',16,9,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+bytes(rgb)*16 for _ in range(9))))+chunk(b'IEND',b'')


class ReportsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.old=(app.ROOT,app.TOKEN)
        app.ROOT=Path(self.tmp.name);app.TOKEN='unit-test-token-at-least-thirty-two-characters'
        app.initialize()
    def tearDown(self):app.ROOT,app.TOKEN=self.old;self.tmp.cleanup()
    def insert(self,section,identifier,day,color):
        data=png(color);name='images/'+identifier+'.png';(app.ROOT/name).write_bytes(data)
        with app.connect() as db:db.execute('INSERT INTO captures(id,day,captured_at,filename,sha256,bytes,metadata,section) VALUES(?,?,?,?,?,?,?,?)',
            (identifier,day,day+'T12:34:00-03:00',name,hashlib.sha256(data).hexdigest(),len(data),'{}',section))
        return data
    def test_migration_preserves_legacy_and_allows_two_distinct_sections(self):
        with app.connect() as db:
            db.execute('DROP INDEX one_capture_per_day_section')
            db.execute('ALTER TABLE captures DROP COLUMN section')
            db.execute('CREATE UNIQUE INDEX one_capture_per_day ON captures(day)')
        app.initialize()
        day=datetime.now(app.TZ).date().isoformat()
        self.insert('top','a'*32,day,(1,2,3));self.insert('middle','b'*32,day,(4,5,6))
        with self.assertRaises(sqlite3.IntegrityError):self.insert('top','c'*32,day,(7,8,9))
        with app.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM captures').fetchone()[0],2)
    def test_docx_is_section_filtered_and_embeds_original_images(self):
        today=datetime.now(app.TZ).date();yesterday=today-timedelta(days=1)
        first=self.insert('top','a'*32,yesterday.isoformat(),(1,2,3))
        second=self.insert('top','b'*32,today.isoformat(),(4,5,6))
        excluded=self.insert('middle','c'*32,today.isoformat(),(7,8,9))
        self.insert('legacy','d'*32,today.isoformat(),(10,11,12))
        server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        base=f'http://127.0.0.1:{server.server_port}'
        path=f'/v1/report.docx?section=top&start={yesterday}&end={today}'
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(base+path)
            self.assertEqual(error.exception.code,401)
            request=urllib.request.Request(base+path,headers={'Authorization':'Bearer '+app.TOKEN})
            with urllib.request.urlopen(request) as response:
                data=response.read();self.assertEqual(response.headers.get_content_type(),MIME)
                self.assertEqual(response.headers['X-Report-SHA256'],hashlib.sha256(data).hexdigest())
            with zipfile.ZipFile(io.BytesIO(data)) as doc:
                images=[doc.read(n) for n in doc.namelist() if n.startswith('word/media/')]
                self.assertCountEqual(images,[first,second]);self.assertNotIn(excluded,images)
                text=doc.read('word/document.xml').decode();self.assertIn('Topo',text);self.assertNotIn('Meio',text)
                self.assertIn(today.strftime('%d/%m/%Y'),text)
        finally:server.shutdown();server.server_close();t.join()


if __name__=='__main__':unittest.main()
