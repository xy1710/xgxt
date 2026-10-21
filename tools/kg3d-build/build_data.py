# -*- coding: utf-8 -*-
"""
xgxt 代码知识图谱 3D 可视化 - 数据装配脚本
从 codebase-memory-mcp 的 query_graph 自动存盘结果中提取节点/边，
组装成 3D 力导向图所需的紧凑 JSON（graph-data.json）。
"""
import json, hashlib, os, sys
from collections import defaultdict

TR = r"C:\Users\西元\.workbuddy\projects\d-良志学管github版-xgxt\367e9f20-9a94-43fa-9983-d01ba61b92f1\tool-results"
REPO = r"D:\良志学管github版\xgxt"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "graph-data.json")

F_NODES = os.path.join(TR, "mcp-codebase-memory-mcp-query_graph-1792411866549-696751.txt")
F_ATTRS = os.path.join(TR, "mcp-codebase-memory-mcp-query_graph-1792412101928-10936e.txt")
F_CALLS = os.path.join(TR, "mcp-codebase-memory-mcp-query_graph-1792411826579-4e623e.txt")
F_DEFINES = os.path.join(TR, "mcp-codebase-memory-mcp-query_graph-1792411866512-5dea75.txt")
F_IMPORTS = os.path.join(TR, "chatcmpl-tool-9ddbf7b91322068e.txt")
F_USAGE = os.path.join(TR, "chatcmpl-tool-ae3900ff6b38522c.txt")
F_MISC = os.path.join(TR, "mcp-codebase-memory-mcp-query_graph-1792412556607-69b835.txt")

LABELS = ["Project","Branch","Folder","File","Module","Function","Route","Interface",
          "Type","Enum","Section","Table","EnvVar","Method","Process","Class"]
LIDX = {l: i for i, l in enumerate(LABELS)}
ETYPES = ["CALLS","DEFINES","IMPORTS","USAGE","CONTAINS_FILE","CONTAINS_FOLDER","HANDLES","HTTP_CALLS"]
EIDX = {t: i for i, t in enumerate(ETYPES)}

PROJ_PREFIX = "D-e889afe5bf97e5ada6e7aea1githube78988-xgxt."

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def num(v):
    if v is None: return None
    v = str(v).strip()
    if v == "": return None
    try: return int(float(v))
    except ValueError: return None

def h3(s):
    """确定性哈希 -> [-1,1]^3"""
    d = hashlib.md5(s.encode("utf-8")).digest()
    return (d[0]/255*2-1, d[1]/255*2-1, d[2]/255*2-1)

def clean_qn(qn):
    if not qn: return ""
    if qn.startswith(PROJ_PREFIX): qn = qn[len(PROJ_PREFIX):]
    if qn.startswith("__env__"): qn = qn[len("__env__"):]
    return qn

# ---------- 1. 节点 ----------
nodes = {}   # id -> dict
for row in load(F_NODES)["rows"]:
    nid, lab_json, name = row[0], row[1], row[2]
    lab = json.loads(lab_json)[0] if lab_json else "Unknown"
    nodes[nid] = {"label": lab, "name": name, "fp": "", "qn": "", "sl": None,
                  "el": None, "cx": None, "sig": "", "imp": None}

# ---------- 2. 属性 ----------
for row in load(F_ATTRS)["rows"]:
    nid, fp, qn, sl, el, cx, sig, imp = row
    if nid in nodes:
        n = nodes[nid]
        n["fp"] = fp or ""
        n["qn"] = clean_qn(qn)
        n["sl"], n["el"] = num(sl), num(el)
        n["cx"] = num(cx)
        n["sig"] = sig or ""
        n["imp"] = num(imp)

# ---------- 3. 边 ----------
edges = []  # (src, tgt, etype_idx)
def add_pairs(path, et):
    d = load(path)
    for r in d["rows"]:
        edges.append((r[0], r[1], et))

add_pairs(F_CALLS, EIDX["CALLS"])
add_pairs(F_DEFINES, EIDX["DEFINES"])
add_pairs(F_IMPORTS, EIDX["IMPORTS"])
add_pairs(F_USAGE, EIDX["USAGE"])

folder_name = {}     # folder id -> name
folder_parent = {}   # folder id -> parent id
file_parent = {}     # file id -> parent id (folder/branch/project)
for r in load(F_MISC)["rows"]:
    src, tgt, et, an, bn = r
    if et == "CONTAINS_FOLDER":
        edges.append((src, tgt, EIDX["CONTAINS_FOLDER"]))
        folder_name.setdefault(tgt, bn)
        folder_name.setdefault(src, an)
        folder_parent[tgt] = src
    elif et == "CONTAINS_FILE":
        edges.append((src, tgt, EIDX["CONTAINS_FILE"]))
        folder_name.setdefault(src, an)
        file_parent[tgt] = src
    elif et == "HANDLES":
        edges.append((src, tgt, EIDX["HANDLES"]))
    elif et == "HTTP_CALLS":
        edges.append((src, tgt, EIDX["HTTP_CALLS"]))

# ---------- 4. 合成 Folder 节点 ----------
for fid, fname in folder_name.items():
    if fid in nodes:      # Project / Branch 已在节点集中
        continue
    nodes[fid] = {"label": "Folder", "name": fname, "fp": "", "qn": fname, "sl": None,
                  "el": None, "cx": None, "sig": "", "imp": None}

nodeset = set(nodes)
edges = [(s, t, k) for (s, t, k) in edges if s in nodeset and t in nodeset]

# ---------- 5. 度数 & 邻接 ----------
deg = defaultdict(int)
out_adj = defaultdict(list)
in_adj = defaultdict(list)
for s, t, k in edges:
    deg[s] += 1; deg[t] += 1
    out_adj[s].append((t, k))
    in_adj[t].append((s, k))

defines_parent = {}   # child -> parent (File/Folder/Module 定义实体)
for s, t, k in edges:
    if k == EIDX["DEFINES"]:
        defines_parent[t] = s

# ---------- 6. 初始位置 ----------
AREA_X = {"server-job": -460.0, "web-job": 460.0, "shared-types": 0.0}
def area_of(fp):
    if not fp: return None
    top = fp.replace("\\", "/").split("/")[0]
    return top if top in AREA_X else None

# 6a. File 节点位置
pos = {}
for nid, n in nodes.items():
    if n["label"] != "File":
        continue
    a = area_of(n["fp"]) or "root"
    cx = AREA_X.get(a, 0.0)
    jx, jy, jz = h3("f:" + nid)
    pos[nid] = (cx + jx*250, jy*300, jz*250 + (0 if a != "root" else -260))

# 6b. Folder 位置 = 子节点质心
children = defaultdict(list)   # folder -> [child ids]
for c, p in file_parent.items(): children[p].append(c)
for c, p in folder_parent.items(): children[p].append(c)

def folder_pos(fid, depth=0):
    if fid in pos: return pos[fid]
    kids = [c for c in children.get(fid, []) if c in nodes]
    if not kids:
        jx, jy, jz = h3("d:" + fid)
        pos[fid] = (jx*120, jy*120, jz*120)
        return pos[fid]
    xs = ys = zs = 0.0
    for c in kids:
        if c in pos: x, y, z = pos[c]
        elif nodes[c]["label"] == "Folder": x, y, z = folder_pos(c, depth+1)
        else:
            a = area_of(nodes[c]["fp"]) or "root"
            jx, jy, jz = h3("e:" + c)
            x, y, z = AREA_X.get(a, 0.0)+jx*220, jy*280, jz*220+(0 if a != "root" else -260)
            pos[c] = (x, y, z)
        xs += x; ys += y; zs += z
    n = len(kids)
    pos[fid] = (xs/n, ys/n, zs/n)
    return pos[fid]

for fid in list(nodes):
    if nodes[fid]["label"] == "Folder":
        folder_pos(fid)
pos["1"] = (0.0, -320.0, 0.0)   # Project
if "2" in nodes: pos["2"] = (0.0, -240.0, 0.0)  # Branch

# 6c. 其余实体：挂在 DEFINES 父节点附近，否则按区域散开
for nid, n in nodes.items():
    if nid in pos: continue
    p = defines_parent.get(nid)
    if p and p in pos:
        jx, jy, jz = h3("n:" + nid)
        pos[nid] = (pos[p][0]+jx*46, pos[p][1]+jy*46, pos[p][2]+jz*46)
    else:
        a = area_of(n["fp"]) or "root"
        cx = AREA_X.get(a, 0.0)
        jx, jy, jz = h3("n:" + nid)
        pos[nid] = (cx + jx*260, jy*320, jz*260 + (0 if a != "root" else -260))

# ---------- 7. 热点代码摘录 ----------
HOT_N = 40
hot_ids = [nid for nid, n in nodes.items()
           if n["label"] in ("Function","Route","Method","Module","Class")
           and n["sl"] and n["el"] and n["fp"]]
hot_ids.sort(key=lambda i: -(deg.get(i, 0) + (nodes[i]["imp"] or 0)*2))
hot_ids = hot_ids[:HOT_N]
code_map = {}
for nid in hot_ids:
    n = nodes[nid]
    path = os.path.join(REPO, n["fp"].replace("/", os.sep))
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        continue
    lo = max(1, n["sl"]-1); hi = min(len(lines), n["el"]+1)
    if hi - lo > 70: hi = lo + 70
    seg = lines[lo-1:hi]
    code_map[nid] = {"file": n["fp"], "start": lo, "lines": seg}

# ---------- 8. 输出 ----------
order = sorted(nodes, key=lambda i: int(i))
idx = {nid: i for i, nid in enumerate(order)}
out_nodes = []
for nid in order:
    n = nodes[nid]
    x, y, z = pos.get(nid, (0, 0, 0))
    a = area_of(n["fp"])
    ax = AREA_X.get(a, 0.0) * 0.9 if a else 0.0
    out_nodes.append([
        idx[nid], LIDX.get(n["label"], 0), n["name"], n["fp"], n["qn"],
        n["sl"] or 0, n["el"] or 0, n["cx"] or 0, n["imp"] or 0,
        deg.get(nid, 0),
        round(x, 1), round(y, 1), round(z, 1),
        round(ax, 1), 0.0, 0.0,
    ])
out_links = [[idx[s], idx[t], k] for (s, t, k) in edges]

from collections import Counter
lc = Counter(nodes[i]["label"] for i in order)
ec = Counter(ETYPES[k] for (_, _, k) in edges)
meta = {
    "nodeCount": len(out_nodes), "linkCount": len(out_links),
    "labelCounts": {l: lc.get(l, 0) for l in LABELS},
    "etypeCounts": {t: ec.get(t, 0) for t in ETYPES},
    "hotCount": len(code_map),
}
data = {"labels": LABELS, "etypes": ETYPES, "nodes": out_nodes,
        "links": out_links, "code": {str(idx[k]): v for k, v in code_map.items()},
        "meta": meta}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

print("nodes:", meta["nodeCount"], " links:", meta["linkCount"])
print("labels:", meta["labelCounts"])
print("etypes:", meta["etypeCounts"])
print("hot code nodes:", meta["hotCount"])
print("written:", OUT, os.path.getsize(OUT), "bytes")
