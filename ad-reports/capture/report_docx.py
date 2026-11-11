"""Create a minimal chronological Word report using original capture bytes."""
from datetime import date, datetime
import hashlib
import io
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

LABELS={'top':'Topo','middle':'Meio'}
MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def build_report(root,rows,section,start,end,destination):
    label=LABELS[section]
    doc=Document();page=doc.sections[0]
    page.page_width=Inches(8.5);page.page_height=Inches(11)
    page.top_margin=page.bottom_margin=Inches(.6)
    page.left_margin=page.right_margin=Inches(.6)
    normal=doc.styles['Normal'];normal.font.name='Arial';normal.font.size=Pt(11)
    normal.font.color.rgb=RGBColor(0,0,0)
    normal.paragraph_format.space_after=Pt(0)
    normal.paragraph_format.line_spacing=1
    normal.paragraph_format.left_indent=normal.paragraph_format.right_indent=Inches(0)
    normal.paragraph_format.first_line_indent=Inches(0)
    title=doc.styles['Title'];title.font.name='Arial';title.font.size=Pt(16);title.font.bold=True
    title.font.color.rgb=RGBColor(0,0,0);title.paragraph_format.space_after=Pt(4)
    title.font.underline=False
    # The distribution's default template can carry an inherited title rule.
    # Keep the report plain and remove that rule from every inherited style.
    for node in list(doc.styles.element.xpath('.//w:pBdr'))+list(doc.element.xpath('.//w:pBdr')):
        node.getparent().remove(node)
    doc.add_paragraph('Relatório de publicidade '+label,style='Title')
    first=date.fromisoformat(start).strftime('%d/%m/%Y');last=date.fromisoformat(end).strftime('%d/%m/%Y')
    intro=doc.add_paragraph(f'Portal Trivox | {first} a {last} | {len(rows)} captura'+('s' if len(rows)!=1 else ''))
    intro.paragraph_format.space_after=Pt(6)
    no_compress=OxmlElement('w:doNotAutoCompressPictures');doc.settings.element.append(no_compress)
    for index,row in enumerate(rows):
        if index and index%2==0:doc.add_page_break()
        p=doc.add_paragraph(date.fromisoformat(row['day']).strftime('%d/%m/%Y'))
        p.paragraph_format.keep_with_next=True;p.paragraph_format.space_before=Pt(3)
        p.paragraph_format.space_after=Pt(2);p.runs[0].bold=True
        image=(Path(root)/row['filename']).resolve()
        if not image.is_relative_to(Path(root).resolve()):raise ValueError('Caminho inválido')
        raw=image.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=row['sha256']:raise ValueError('Imagem original não corresponde ao índice')
        picture=doc.add_paragraph();picture.paragraph_format.space_after=Pt(6)
        picture.alignment=WD_ALIGN_PARAGRAPH.CENTER
        picture.paragraph_format.left_indent=picture.paragraph_format.right_indent=Inches(0)
        picture.paragraph_format.first_line_indent=Inches(0)
        run=picture.add_run();run.font.size=Pt(1)
        inline=run.add_picture(io.BytesIO(raw),width=Inches(7.3))
        inline._inline.docPr.set('descr',f'Captura do {label.lower()} do Portal Trivox em '+date.fromisoformat(row['day']).strftime('%d/%m/%Y'))
    doc.core_properties.title='Relatório de publicidade '+label
    doc.core_properties.author='Portal Trivox'
    doc.core_properties.subject=f'Capturas da seção {label} entre {first} e {last}'
    doc.core_properties.created=doc.core_properties.modified=datetime.utcnow()
    doc.save(destination)
