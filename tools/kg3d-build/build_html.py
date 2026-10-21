# -*- coding: utf-8 -*-
"""把 three.min.js / 3d-force-graph.min.js / graph-data.json / app.js 内联进模板，
生成完全自包含的 3D 知识图谱 HTML。"""
import json, os

BASE = os.path.dirname(os.path.abspath(__file__))
NM = r"C:\Users\西元\.workbuddy\binaries\node\workspace\node_modules"
OUT_HTML = r"D:\良志学管github版\xgxt\代码知识图谱3D.html"

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

def safe_js(s):
    # 防止内联脚本中出现 </script> 提前闭合标签
    return s.replace("</script", "<\\/script")

three = safe_js(read(os.path.join(NM, "three", "build", "three.min.js")))
fg = safe_js(read(os.path.join(NM, "3d-force-graph", "dist", "3d-force-graph.min.js")))
app = safe_js(read(os.path.join(BASE, "app.js")))

data = json.dumps(json.loads(read(os.path.join(BASE, "graph-data.json"))),
                  ensure_ascii=False, separators=(",", ":"))
data = safe_js(data)

tpl = read(os.path.join(BASE, "index.template.html"))
html = (tpl
        .replace("@@THREE@@", three)
        .replace("@@FG@@", fg)
        .replace("@@DATA@@", data)
        .replace("@@APP@@", app))

for ph in ["@@THREE@@", "@@FG@@", "@@DATA@@", "@@APP@@"]:
    assert ph not in html, ph + " not replaced"

with open(OUT_HTML, "w", encoding="utf-8") as f:
    f.write(html)

print("written:", OUT_HTML)
print("size: %.2f MB" % (os.path.getsize(OUT_HTML) / 1048576))
