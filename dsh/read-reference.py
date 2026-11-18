"""Bounded, read-only operations called by the current DSH shell tool."""
import base64
import json
import os
from pathlib import Path
import sys
from xml.etree import ElementTree as ET
import zipfile
import zlib


def local(tag):
    return tag.rsplit("}", 1)[-1]


def xml_part(archive, name):
    if archive.getinfo(name).file_size > 8_000_000:
        raise ValueError("part too large")
    return ET.fromstring(archive.read(name))


def compact(node):
    attrs = " ".join((v if local(k) == "val" else local(k) + "=" + v) for k, v in node.attrib.items() if not local(k).startswith("rsid"))
    children = " ".join(compact(c) for c in node)
    value = " ".join(x for x in (attrs, children, (node.text or "").strip()) if x)
    return local(node.tag) + ("(" + value + ")" if value else "")


def word_guide(file):
    with zipfile.ZipFile(file) as archive:
        names = archive.namelist()
        if any(name.startswith(("word/media/", "word/header", "word/footer", "word/comments", "word/embeddings/")) for name in names):
            raise ValueError("guide requires native visual/document inspection")
        for part in ("footnotes", "endnotes"):
            name = "word/" + part + ".xml"
            if name in names and any(local(e.tag) == part[:-1] and not any(local(k) == "type" and v in ("separator", "continuationSeparator") for k, v in e.attrib.items()) for e in xml_part(archive, name)):
                raise ValueError("notes require native inspection")
        root = xml_part(archive, "word/document.xml")
        w = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        body = root.find(w + "body")
        if body is None or any(local(c.tag) not in ("p", "sectPr") for c in body):
            raise ValueError("complex guide layout")
        formats, styles, paragraphs = [], set(), []
        def format_id(props):
            if props is None or not len(props):
                return ""
            for e in props.iter():
                if local(e.tag) in ("pStyle", "rStyle"):
                    styles.add(e.get(w + "val"))
            value = compact(props)
            if value not in formats:
                formats.append(value)
            return "f" + str(formats.index(value) + 1)
        def contents(parent):
            parts = []
            for c in parent:
                tag = local(c.tag)
                if tag in ("pPr", "rPr", "bookmarkEnd", "proofErr", "lastRenderedPageBreak", "bookmarkStart", "fldChar"):
                    continue
                if tag in ("r", "hyperlink"):
                    inner = contents(c)
                    fmt = format_id(c.find(w + "rPr")) if tag == "r" else c.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id", "")
                    if inner:
                        parts.append((fmt, inner))
                elif tag == "t":
                    parts.append(("", c.text or ""))
                elif tag == "instrText":
                    if not (c.text or "").strip().startswith(("TOC ", "PAGEREF ", "HYPERLINK ")):
                        raise ValueError("unresolved document field")
                elif tag == "tab":
                    parts.append(("", "\t"))
                elif tag in ("br", "cr"):
                    parts.append(("", "\n"))
                else:
                    raise ValueError("unsupported Word content: " + tag)
            return "".join(("[" + fmt + "]" + text + "[/]" if fmt else text) for fmt, text in parts)
        for p in body.findall(w + "p"):
            paragraphs.append([format_id(p.find(w + "pPr")), contents(p)])
        definitions, style_map = {}, {}
        if "word/styles.xml" in names:
            sheet = xml_part(archive, "word/styles.xml")
            style_map = {e.get(w + "styleId"): e for e in sheet.findall(w + "style")}
            styles.update(k for k, e in style_map.items() if e.get(w + "default") == "1")
            while styles:
                key = styles.pop()
                if key in definitions or key not in style_map:
                    continue
                e = style_map[key]
                definitions[key] = compact(e)
                styles.update(b.get(w + "val") for b in e.findall(w + "basedOn"))
            defaults = sheet.find(w + "docDefaults")
            if defaults is not None:
                definitions["docDefaults"] = compact(defaults)
        layout = body.find(w + "sectPr")
        data = {"formats": formats, "styles": definitions}
        if layout is not None:
            data["section"] = compact(layout)
        if "numPr" in json.dumps(data) and "word/numbering.xml" in names:
            numbering = xml_part(archive, "word/numbering.xml")
            ids = {n.get(w + "val") for n in root.iter(w + "numId")}
            for key in definitions:
                if key in style_map:
                    ids.update(n.get(w + "val") for n in style_map[key].iter(w + "numId"))
            nums = [n for n in numbering.findall(w + "num") if n.get(w+"numId") in ids]
            abs_ids = {e.get(w+"val") for n in nums for e in n.findall(w+"abstractNumId")}
            data["numbering"] = [compact(e) for e in numbering.findall(w+"abstractNum") if e.get(w+"abstractNumId") in abs_ids] + [compact(n) for n in nums]
        if "word/_rels/document.xml.rels" in names:
            data["hyperlinks"] = {e.get("Id"): e.get("Target") for e in xml_part(archive, "word/_rels/document.xml.rels") if e.get("Type", "").endswith("/hyperlink")}
        if "word/theme/theme1.xml" in names:
            theme = xml_part(archive, "word/theme/theme1.xml")
            data["themeColors"] = [compact(e) for e in theme.iter() if local(e.tag) == "clrScheme"]
        text = "\n".join((fmt + " " if fmt else "") + line for fmt, line in paragraphs)
        return "Word 原件，f1 起为原件格式编号。\n" + text + "\n格式与编号定义：" + json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def evidence(file, path, args):
    suffix = path.suffix.lower()
    if args["op"] == "guide":
        if suffix in (".png", ".jpg", ".jpeg", ".webp") and os.fstat(file.fileno()).st_size <= 100000:
            raw = file.read()
            if raw.startswith(b"\x89PNG\r\n\x1a\n"):
                mime = "image/png"
            elif raw.startswith(b"\xff\xd8\xff"):
                mime = "image/jpeg"
            elif raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
                mime = "image/webp"
            else:
                raise ValueError("unrecognized image")
            return {"type": "image_url", "image_url": {"url": "data:" + mime + ";base64," + base64.b64encode(raw).decode()}}
        if suffix == ".docx":
            return word_guide(file)
        if suffix in (".txt", ".md"):
            return file.read(131073).decode("utf-8-sig", errors="strict")
        raise ValueError("unsupported guide format")
    query = args["query"]
    if suffix in (".txt", ".md"):
        lines = file.read(2_000_001).decode("utf-8-sig").splitlines()
        return [{"line": i+1, "fromLine": max(1,i), "lines": lines[max(i-1,0):i+2]} for i, line in enumerate(lines) if query in line][:9]
    if suffix != ".xlsx":
        raise ValueError("unsupported lookup format")
    import openpyxl
    book = openpyxl.load_workbook(file, read_only=True, data_only=True)
    try:
        if not args.get("sheet") or not args.get("headerRow"):
            return {"sheets": [{"sheet": s.title, "firstRows": list(s.iter_rows(max_row=3, max_col=12, values_only=True))}
                               for s in ([book[args["sheet"]]] if args.get("sheet") else book.worksheets)]}
        sheet = book[args["sheet"]]
        header = args["headerRow"]
        rows = sheet.iter_rows(min_row=header, values_only=True)
        labels = next(rows)
        result = []
        for index, row in enumerate(rows, header+1):
            if any(query in str(v) for v in row if v is not None):
                result.append({"sheet": sheet.title, "headerRow": header, "row": index, "headers": labels, "values": row})
                if len(result) == 9:
                    break
        return result
    finally:
        book.close()


def main():
    args = json.loads(base64.b64decode(sys.argv[1]))
    path = Path(args["path"]).resolve(strict=True)
    if not path.is_relative_to(Path(args["workspace"]).resolve(strict=True)):
        raise ValueError("outside workspace")
    with path.open("rb") as file:
        st = os.fstat(file.fileno())
        stamp = [str(path), str(st.st_dev), str(st.st_ino), str(st.st_size), str(st.st_mtime_ns), str(st.st_ctime_ns)]
        value = None
        if args["op"] != "probe":
            if st.st_size > (2_000_000 if path.suffix.lower() in (".md", ".txt") else 32_000_000):
                raise ValueError("original requires native search")
            if args["op"] == "guide" and path.suffix.lower() in (".txt", ".md") and st.st_size > 131072:
                raise ValueError("large guide")
            value = evidence(file, path, args)
            if os.fstat(file.fileno()).st_mtime_ns != st.st_mtime_ns:
                raise ValueError("original changed")
        raw = json.dumps({"stamp": stamp, "value": value}, ensure_ascii=False, default=str).encode()
        if len(raw) > 180000:
            raise ValueError("evidence too large")
        print("KAMI1 " + base64.b64encode(zlib.compress(raw)).decode())


if __name__ == "__main__":
    main()
