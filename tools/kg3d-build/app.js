/* xgxt 代码知识图谱 3D - 前端应用 */
(function () {
  'use strict';

  /* ================= 数据 ================= */
  var DATA = window.KG3D_DATA;
  var LABELS = DATA.labels, ETYPES = DATA.etypes, META = DATA.meta;

  var LABEL_CN = {
    Project: '项目', Branch: '分支', Folder: '目录', File: '文件', Module: '模块',
    Function: '函数', Route: '路由', Interface: '接口', Type: '类型', Enum: '枚举',
    Section: '区块', Table: '数据表', EnvVar: '环境变量', Method: '方法',
    Process: '进程', Class: '类'
  };
  var ETYPE_CN = {
    CALLS: '调用', DEFINES: '定义', IMPORTS: '导入', USAGE: '使用',
    CONTAINS_FILE: '包含文件', CONTAINS_FOLDER: '包含目录',
    HANDLES: '处理路由', HTTP_CALLS: 'HTTP 调用'
  };
  var LABEL_COLORS = {
    Project: '#dc2626', Branch: '#b45309', Folder: '#7c3aed', File: '#2563eb',
    Module: '#ea580c', Function: '#16a34a', Route: '#db2777', Interface: '#0891b2',
    Type: '#65a30d', Enum: '#ca8a04', Section: '#c026d3', Table: '#0f766e',
    EnvVar: '#64748b', Method: '#059669', Process: '#4f46e5', Class: '#9f1239'
  };
  var ETYPE_COLORS = {
    CALLS: '#2563eb', DEFINES: '#7c3aed', IMPORTS: '#0891b2', USAGE: '#94a3b8',
    CONTAINS_FILE: '#c026d3', CONTAINS_FOLDER: '#a855f7', HANDLES: '#db2777',
    HTTP_CALLS: '#ea580c'
  };
  var AREA_COLORS = { 'server-job': '#2563eb', 'web-job': '#ea580c', 'shared-types': '#16a34a', 'root': '#64748b' };
  var BASE_R = {
    Project: 11, Branch: 7, Folder: 4.2, File: 2.3, Module: 2.1, Function: 1.25,
    Route: 1.6, Interface: 1.4, Type: 1.25, Enum: 1.15, Section: 1.05,
    Table: 1.8, EnvVar: 1.05, Method: 1.15, Process: 1.9, Class: 1.5
  };
  var LINK_DIST = { 0: 62, 1: 36, 2: 82, 3: 48, 4: 22, 5: 26, 6: 44, 7: 44 };
  var LINK_STRENGTH = { 0: 0.35, 1: 0.8, 2: 0.22, 3: 0.3, 4: 1.0, 5: 0.9, 6: 0.6, 7: 0.6 };

  /* ================= 模型 ================= */
  var nodes = DATA.nodes.map(function (a) {
    return {
      id: a[0], li: a[1], name: a[2], fp: a[3], qn: a[4], sl: a[5], el: a[6],
      cx: a[7], imp: a[8], deg: a[9], x: a[10], y: a[11], z: a[12],
      ax: a[13], ay: a[14], az: a[15], r: 0
    };
  });
  nodes.forEach(function (n) {
    var base = BASE_R[LABELS[n.li]] || 1.2;
    n.r = Math.min(15, base + Math.sqrt(n.deg || 0) * 0.32);
  });
  var links = DATA.links.map(function (a) {
    return { source: a[0], target: a[1], k: a[2] };
  });

  var byId = new Map();
  nodes.forEach(function (n) { byId.set(n.id, n); });
  var outMap = new Map(), inMap = new Map(), adjSet = new Map();
  function push(map, k, v) { var arr = map.get(k); if (!arr) { arr = []; map.set(k, arr); } arr.push(v); }
  links.forEach(function (l) {
    push(outMap, l.source, l); push(inMap, l.target, l);
    var s = adjSet.get(l.source); if (!s) { s = new Set(); adjSet.set(l.source, s); } s.add(l.target);
    var t = adjSet.get(l.target); if (!t) { t = new Set(); adjSet.set(l.target, t); } t.add(l.source);
  });
  var fpToFile = new Map();
  nodes.forEach(function (n) { if (n.li === LABELS.indexOf('File') && n.fp) fpToFile.set(n.fp, n.id); });

  /* ================= 状态 ================= */
  var selected = null, navStack = [];
  var colorMode = 'label';
  var hiddenLabels = new Set();
  var CODE = DATA.code || {};

  function areaKey(n) {
    if (!n.fp) return 'root';
    var top = n.fp.replace(/\\/g, '/').split('/')[0];
    return AREA_COLORS.hasOwnProperty(top) ? top : 'root';
  }
  function heat(t) { // 0..1 -> 绿->黄->红
    t = Math.max(0, Math.min(1, t));
    var c;
    if (t < 0.5) { c = mix([34, 197, 94], [234, 179, 8], t * 2); }
    else { c = mix([234, 179, 8], [239, 68, 68], (t - 0.5) * 2); }
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }
  function mix(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }

  function isLabelVisible(n) { return !hiddenLabels.has(n.li); }
  function linkVisible(l) { return isLabelVisible(l.source) && isLabelVisible(l.target); }

  /* ================= 3D 图 ================= */
  function nodeVal(n) {
    var r = n.r;
    if (selected !== null) {
      if (n.id === selected) r *= 2.1;
      else if (adjSet.get(selected) && adjSet.get(selected).has(n.id)) r *= 1.5;
    }
    return r * r * r;
  }
  function nodeColor(n) {
    if (selected !== null && !isNeighborOrSelf(n.id)) return 'rgba(148,163,184,0.28)';
    if (colorMode === 'area') return AREA_COLORS[areaKey(n)];
    if (colorMode === 'cx') return heat(Math.log((n.cx || 0) + 1) / Math.log(31));
    if (colorMode === 'deg') return heat(Math.sqrt(n.deg || 0) / 8);
    return LABEL_COLORS[LABELS[n.li]] || '#334155';
  }
  function isNeighborOrSelf(id) {
    if (id === selected) return true;
    var s = adjSet.get(selected);
    return !!(s && s.has(id));
  }
  var LINK_BASE = 'rgba(100,116,139,0.14)';
  function linkColor(l) {
    if (!linkVisible(l)) return 'rgba(0,0,0,0)';
    if (selected !== null) {
      if (l.source.id === selected) return '#2563eb';
      if (l.target.id === selected) return '#d97706';
      if (isNeighborOrSelf(l.source.id) && isNeighborOrSelf(l.target.id)) return 'rgba(100,116,139,0.4)';
      return 'rgba(148,163,184,0.07)';
    }
    return LINK_BASE;
  }
  function linkWidth(l) {
    if (selected !== null && (l.source.id === selected || l.target.id === selected)) return 1.5;
    return 0.4;
  }
  function linkArrow(l) {
    return (selected !== null && (l.source.id === selected || l.target.id === selected)) ? 4 : 0;
  }
  function linkParticles(l) {
    return (selected !== null && (l.source.id === selected || l.target.id === selected)) ? 2 : 0;
  }
  function particleColor(l) { return l.source.id === selected ? '#2563eb' : '#d97706'; }
  function nodeVisibility(n) { return isLabelVisible(n); }
  function linkVisibilityFn(l) { return linkVisible(l); }

  function anchorForce(s) {
    var ns;
    var f = function () {
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i];
        n.vx += (n.ax - n.x) * s;
        n.vy += (n.ay - n.y) * s;
        n.vz += (n.az - n.z) * s;
      }
    };
    f.initialize = function (n) { ns = n; };
    return f;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nodeTip(n) {
    return '<div class="kg-tip"><div class="kg-tip-head"><i style="background:' +
      (LABEL_COLORS[LABELS[n.li]] || '#334155') + '"></i><b>' + esc(n.name) + '</b>' +
      '<span class="kg-tip-label">' + esc(LABEL_CN[LABELS[n.li]] || LABELS[n.li]) + '</span></div>' +
      (n.fp ? '<div class="kg-tip-path">' + esc(n.fp) + (n.sl ? ':' + n.sl + (n.el && n.el !== n.sl ? '-' + n.el : '') : '') + '</div>' : '') +
      '<div class="kg-tip-deg">连接数 ' + (n.deg || 0) + (n.cx ? ' · 复杂度 ' + n.cx : '') + '</div></div>';
  }

  // 注意：3d-force-graph 个别 setter 在某些版本不返回可链式对象，
  // 因此改为逐条离散赋值，避免一处返回 undefined 导致整条链崩溃。
  var Graph = ForceGraph3D()(document.getElementById('3d-graph'));
  Graph.graphData({ nodes: nodes, links: links });
  Graph.nodeVal(nodeVal);
  Graph.nodeRelSize(1);
  Graph.nodeResolution(10);
  Graph.nodeOpacity(0.95);
  Graph.nodeColor(nodeColor);
  Graph.nodeLabel(nodeTip);
  Graph.nodeVisibility(nodeVisibility);
  Graph.linkColor(linkColor);
  Graph.linkWidth(linkWidth);
  Graph.linkOpacity(0.9);
  Graph.linkVisibility(linkVisibilityFn);
  Graph.linkDirectionalArrowLength(linkArrow);
  Graph.linkDirectionalArrowColor(linkColor);
  Graph.linkDirectionalArrowRelPos(0.82);
  Graph.linkDirectionalParticles(linkParticles);
  Graph.linkDirectionalParticleWidth(1.6);
  Graph.linkDirectionalParticleSpeed(0.006);
  Graph.linkDirectionalParticleColor(particleColor);
  Graph.backgroundColor('#eef2f7');
  Graph.showNavInfo(false);
  Graph.onNodeClick(function (n) { selectNode(n.id, true); });
  Graph.onBackgroundClick(function () { clearSelection(); });
  Graph.onNodeHover(function (n) { document.getElementById('3d-graph').style.cursor = n ? 'pointer' : 'default'; });
  Graph.d3Force('charge').strength(-150);
  Graph.d3Force('link').distance(function (l) { return LINK_DIST[l.k] || 50; });
  Graph.d3Force('link').strength(function (l) { return LINK_STRENGTH[l.k] != null ? LINK_STRENGTH[l.k] : 0.4; });
  Graph.d3Force('center').strength(0.06);
  Graph.d3Force('anchor', anchorForce(0.016));
  Graph.warmupTicks(160);
  Graph.cooldownTicks(420);
  Graph.d3VelocityDecay(0.38);

  setTimeout(function () {
    Graph.cameraPosition({ x: 60, y: 320, z: 1750 }, { x: 0, y: 0, z: 0 }, 0);
  }, 60);
  window.addEventListener('resize', function () {
    var el = document.getElementById('graph-wrap');
    Graph.width(el.clientWidth).height(el.clientHeight);
  });

  function refreshStyles() {
    Graph.nodeVal(nodeVal);
    Graph.nodeColor(nodeColor);
    Graph.linkColor(linkColor);
    Graph.linkWidth(linkWidth);
    Graph.linkDirectionalArrowLength(linkArrow);
    Graph.linkDirectionalParticles(linkParticles);
    Graph.refresh();
  }

  /* ================= 选择 / 面板 ================= */
  function selectNode(id, fly) {
    if (selected !== null) navStack.push(selected);
    if (navStack.length > 50) navStack.shift();
    selected = id;
    refreshStyles();
    renderPanel();
    if (fly !== false) {
      var n = byId.get(id);
      if (n) Graph.cameraPosition({ x: n.x + 110, y: n.y + 70, z: n.z + 110 }, { x: n.x, y: n.y, z: n.z }, 900);
    }
    var p = document.getElementById('detail-panel');
    p.classList.remove('hidden');
  }
  function clearSelection() {
    selected = null;
    refreshStyles();
    document.getElementById('detail-panel').classList.add('hidden');
  }
  function goBack() {
    var prev = navStack.pop();
    if (prev == null) { clearSelection(); return; }
    selected = prev;
    refreshStyles();
    renderPanel();
    var n = byId.get(prev);
    if (n) Graph.cameraPosition({ x: n.x + 110, y: n.y + 70, z: n.z + 110 }, { x: n.x, y: n.y, z: n.z }, 700);
  }

  function relItem(n) {
    var c = LABEL_COLORS[LABELS[n.li]] || '#334155';
    var loc = n.sl ? '<span class="rel-loc">:' + n.sl + '</span>' : '';
    return '<div class="rel-item" data-id="' + n.id + '" title="' + esc(n.fp || n.qn || '') + '">' +
      '<i style="background:' + c + '"></i>' +
      '<span class="rel-name">' + esc(n.name) + '</span>' +
      '<span class="rel-label" style="color:' + c + '">' + esc(LABEL_CN[LABELS[n.li]] || LABELS[n.li]) + '</span>' +
      loc + '</div>';
  }
  function relSection(title, icon, color, list, total) {
    if (!total) return '';
    var shown = list.slice(0, 40);
    var more = total > shown.length ? '<div class="rel-more">… 共 ' + total + ' 条</div>' : '';
    return '<div class="rel-sec"><div class="rel-sec-head" style="border-color:' + color + '">' +
      '<span class="rel-sec-title">' + icon + ' ' + title + '</span><span class="rel-sec-count">' + total + '</span></div>' +
      '<div class="rel-list">' + shown.map(relItem).join('') + more + '</div></div>';
  }
  function collect(map, etype) {
    var arr = map.get(selected) || [];
    return arr.filter(function (l) { return l.k === etype; });
  }
  function neighborsOf(map, etype) {
    return collect(map, etype).map(function (l) { return byId.get(l.source.id === selected ? l.target.id : l.source.id); })
      .filter(Boolean).sort(function (a, b) { return (b.deg || 0) - (a.deg || 0); });
  }

  function twoHopCalls() {
    var first = adjSet.get(selected) || new Set();
    var seen = new Set(first); seen.add(selected);
    var out = [];
    first.forEach(function (id) {
      (adjSet.get(id) || new Set()).forEach(function (id2) {
        if (!seen.has(id2)) { seen.add(id2); out.push(id2); }
      });
    });
    return out.map(function (id) { return byId.get(id); }).filter(Boolean)
      .sort(function (a, b) { return (b.deg || 0) - (a.deg || 0); }).slice(0, 24);
  }

  function renderPanel() {
    var n = byId.get(selected);
    if (!n) return;
    var label = LABELS[n.li];
    var color = LABEL_COLORS[label] || '#334155';
    var loc = n.fp ? n.fp + (n.sl ? ':' + n.sl + (n.el && n.el !== n.sl ? '-' + n.el : '') : '') : '';
    var code = CODE[String(selected)];
    var fileId = n.fp ? fpToFile.get(n.fp) : null;

    var head = '<div class="dp-title"><i class="dp-dot" style="background:' + color + '"></i>' +
      '<span class="dp-name" title="' + esc(n.name) + '">' + esc(n.name) + '</span>' +
      '<span class="dp-badge" style="background:' + color + '">' + esc(LABEL_CN[label] || label) + '</span></div>' +
      '<div class="dp-actions">' +
      '<button class="dp-back" id="dp-back" title="返回上一个节点">‹</button>' +
      '<button class="dp-close" id="dp-close" title="关闭 (Esc)">×</button></div>';
    document.getElementById('detail-head').innerHTML = head;

    var html = '';
    html += '<div class="dp-meta">';
    if (n.qn && n.qn !== n.name) html += '<div class="dp-row"><span>限定名</span><code>' + esc(n.qn) + '</code></div>';
    if (loc) html += '<div class="dp-row"><span>位置</span><code>' + esc(loc) + '</code></div>';
    if (n.sl) html += '<div class="dp-row"><span>行范围</span><code>' + n.sl + ' – ' + n.el + '</code></div>';
    if (n.cx) html += '<div class="dp-row"><span>圈复杂度</span><code>' + n.cx + '</code></div>';
    if (n.imp) html += '<div class="dp-row"><span>重要度</span><code>' + n.imp + '</code></div>';
    var outs = (outMap.get(selected) || []).length, ins = (inMap.get(selected) || []).length;
    html += '<div class="dp-row"><span>连接度</span><code>出 ' + outs + ' · 入 ' + ins + '</code></div>';
    if (fileId != null && fileId !== selected) {
      html += '<div class="dp-row"><button class="dp-link" data-id="' + fileId + '">定位到所属文件节点 ›</button></div>';
    }
    html += '</div>';

    if (code) {
      var lines = code.lines.map(function (ln, i) {
        var no = code.start + i;
        var hl = (n.sl && no >= n.sl && no <= n.el) ? ' class="code-hl"' : '';
        return '<div' + hl + '><span class="code-no">' + no + '</span>' + esc(ln) + '</div>';
      }).join('');
      html += '<div class="dp-code"><div class="dp-code-head">代码摘录 · ' + esc(code.file) +
        ' <span class="dp-code-range">L' + code.start + '–' + (code.start + code.lines.length - 1) + '</span></div>' +
        '<pre>' + lines + '</pre></div>';
    }

    var callsOut = neighborsOf(outMap, 0), callsIn = neighborsOf(inMap, 0);
    html += relSection('调用（出 → 被它调用）', '📞', ETYPE_COLORS.CALLS, callsOut, callsOut.length);
    html += relSection('被调用（入 ← 调用者）', '📲', ETYPE_COLORS.CALLS, callsIn, callsIn.length);

    var defOut = neighborsOf(outMap, 1), defIn = neighborsOf(inMap, 1);
    html += relSection('定义（出 → 它定义的实体）', '🧩', ETYPE_COLORS.DEFINES, defOut, defOut.length);
    html += relSection('被定义于（入 ← 宿主）', '📦', ETYPE_COLORS.DEFINES, defIn, defIn.length);

    var impOut = neighborsOf(outMap, 2), impIn = neighborsOf(inMap, 2);
    html += relSection('导入（出 → 依赖）', '📥', ETYPE_COLORS.IMPORTS, impOut, impOut.length);
    html += relSection('被导入（入 ← 依赖方）', '📤', ETYPE_COLORS.IMPORTS, impIn, impIn.length);

    var usgOut = neighborsOf(outMap, 3), usgIn = neighborsOf(inMap, 3);
    html += relSection('使用（出 →）', '🔧', ETYPE_COLORS.USAGE, usgOut, usgOut.length);
    html += relSection('被使用（入 ←）', '🔩', ETYPE_COLORS.USAGE, usgIn, usgIn.length);

    var hOut = neighborsOf(outMap, 6), hIn = neighborsOf(inMap, 6);
    html += relSection('处理路由（出 →）', '🛣️', ETYPE_COLORS.HANDLES, hOut, hOut.length);
    var hcOut = neighborsOf(outMap, 7), hcIn = neighborsOf(inMap, 7);
    html += relSection('HTTP 调用（出 →）', '🌐', ETYPE_COLORS.HTTP_CALLS, hcOut, hcOut.length);
    html += relSection('HTTP 被调用（入 ←）', '📡', ETYPE_COLORS.HTTP_CALLS, hcIn, hcIn.length);

    var cfIn = neighborsOf(inMap, 4);
    html += relSection('所属目录（入 ←）', '📁', ETYPE_COLORS.CONTAINS_FILE, cfIn, cfIn.length);

    var two = twoHopCalls();
    if (two.length) html += relSection('二跳调用网络（距离 2 跳的调用关联）', '🕸️', '#475569', two, two.length);

    document.getElementById('detail-body').innerHTML = html;
    document.getElementById('dp-back').style.visibility = navStack.length ? 'visible' : 'hidden';
    document.getElementById('dp-close').onclick = clearSelection;
    document.getElementById('dp-back').onclick = goBack;
    Array.prototype.forEach.call(document.querySelectorAll('.rel-item,.dp-link'), function (el) {
      el.onclick = function () { selectNode(parseInt(el.getAttribute('data-id'), 10), true); };
    });
    document.getElementById('detail-body').scrollTop = 0;
  }

  /* ================= 顶部：统计 / 搜索 / 颜色 ================= */
  function fmt(n) { return (n || 0).toLocaleString('zh-CN'); }
  document.getElementById('stats').innerHTML =
    '<span class="chip"><b>' + fmt(META.nodeCount) + '</b> 节点</span>' +
    '<span class="chip"><b>' + fmt(META.linkCount) + '</b> 关系边</span>' +
    '<span class="chip"><b>' + fmt(META.labelCounts.File) + '</b> 文件</span>' +
    '<span class="chip"><b>' + fmt(META.labelCounts.Function) + '</b> 函数</span>' +
    '<span class="chip"><b>' + fmt(META.labelCounts.Route) + '</b> 路由</span>' +
    '<span class="chip"><b>' + fmt(META.labelCounts.Interface) + '</b> 接口</span>';

  var searchInput = document.getElementById('search');
  var searchBox = document.getElementById('search-results');
  var searchTimer = null;
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { searchInput.value = ''; searchBox.classList.add('hidden'); }
    if (e.key === 'Enter') {
      var first = searchBox.querySelector('.rel-item');
      if (first) selectNode(parseInt(first.getAttribute('data-id'), 10), true);
    }
  });
  document.addEventListener('click', function (e) {
    if (!searchBox.contains(e.target) && e.target !== searchInput) searchBox.classList.add('hidden');
  });
  function runSearch() {
    var q = searchInput.value.trim().toLowerCase();
    if (!q) { searchBox.classList.add('hidden'); return; }
    var hits = [];
    for (var i = 0; i < nodes.length && hits.length < 60; i++) {
      var n = nodes[i];
      if (n.name.toLowerCase().indexOf(q) >= 0 || (n.fp && n.fp.toLowerCase().indexOf(q) >= 0) ||
        (n.qn && n.qn.toLowerCase().indexOf(q) >= 0)) {
        hits.push(n);
      }
    }
    hits.sort(function (a, b) { return (b.deg || 0) - (a.deg || 0); });
    if (!hits.length) {
      searchBox.innerHTML = '<div class="sr-empty">未找到匹配节点</div>';
    } else {
      searchBox.innerHTML = hits.slice(0, 12).map(function (n) {
        var c = LABEL_COLORS[LABELS[n.li]] || '#334155';
        return '<div class="rel-item" data-id="' + n.id + '"><i style="background:' + c + '"></i>' +
          '<span class="rel-name">' + esc(n.name) + '</span>' +
          '<span class="rel-label" style="color:' + c + '">' + esc(LABEL_CN[LABELS[n.li]] || LABELS[n.li]) + '</span>' +
          (n.fp ? '<span class="sr-path">' + esc(n.fp) + '</span>' : '') + '</div>';
      }).join('');
      Array.prototype.forEach.call(searchBox.querySelectorAll('.rel-item'), function (el) {
        el.onclick = function () { selectNode(parseInt(el.getAttribute('data-id'), 10), true); searchBox.classList.add('hidden'); };
      });
    }
    searchBox.classList.remove('hidden');
  }

  document.getElementById('colorby').addEventListener('change', function () {
    colorMode = this.value;
    refreshStyles();
    renderLegend();
  });

  /* ================= 左侧：图例 / 过滤 ================= */
  function renderLegend() {
    var order = ['Project', 'Branch', 'Folder', 'File', 'Module', 'Function', 'Route',
      'Interface', 'Type', 'Enum', 'Section', 'Table', 'EnvVar', 'Method', 'Process', 'Class'];
    var html = '<div class="lg-title">节点类型 <span class="lg-sub">点击筛选显示</span></div>';
    order.forEach(function (lab) {
      var li = LABELS.indexOf(lab);
      var count = META.labelCounts[lab] || 0;
      if (!count) return;
      var off = hiddenLabels.has(li);
      html += '<div class="lg-item' + (off ? ' lg-off' : '') + '" data-li="' + li + '">' +
        '<i style="background:' + LABEL_COLORS[lab] + '"></i>' +
        '<span class="lg-name">' + LABEL_CN[lab] + '</span>' +
        '<span class="lg-count">' + fmt(count) + '</span></div>';
    });
    html += '<div class="lg-title lg-title2">关系类型</div>';
    ETYPES.forEach(function (et, i) {
      var c = META.etypeCounts[et] || 0;
      html += '<div class="lg-item lg-edge"><i class="lg-line" style="background:' + ETYPE_COLORS[et] + '"></i>' +
        '<span class="lg-name">' + ETYPE_CN[et] + '</span><span class="lg-count">' + fmt(c) + '</span></div>';
    });
    html += '<div class="lg-foot">已排除 4,564 个 Variable 变量节点以降低视觉噪音<br>（变量定义/使用关系可在源码查询中查看）</div>';
    document.getElementById('layer-body').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('.lg-item[data-li]'), function (el) {
      el.onclick = function () {
        var li = parseInt(el.getAttribute('data-li'), 10);
        if (hiddenLabels.has(li)) hiddenLabels.delete(li); else hiddenLabels.add(li);
        Graph.nodeVisibility(nodeVisibility).linkVisibility(linkVisibilityFn).refresh();
        renderLegend();
      };
    });
  }
  renderLegend();

  document.getElementById('btn-reset').onclick = function () {
    Graph.cameraPosition({ x: 60, y: 320, z: 1750 }, { x: 0, y: 0, z: 0 }, 1000);
  };
  document.getElementById('btn-clear').onclick = clearSelection;
  document.getElementById('btn-all').onclick = function () {
    hiddenLabels.clear();
    Graph.nodeVisibility(nodeVisibility).linkVisibility(linkVisibilityFn).refresh();
    renderLegend();
  };
  document.getElementById('btn-help').onclick = function () {
    document.getElementById('help-modal').classList.remove('hidden');
  };
  document.getElementById('help-close').onclick = function () {
    document.getElementById('help-modal').classList.add('hidden');
  };
  document.getElementById('help-modal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.add('hidden');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.getElementById('help-modal').classList.add('hidden');
      searchBox.classList.add('hidden');
    }
  });
  document.getElementById('layer-toggle').onclick = function () {
    var p = document.getElementById('layer-panel');
    p.classList.toggle('collapsed');
    this.textContent = p.classList.contains('collapsed') ? '展开 ▼' : '收起 ▲';
  };

  /* 帮助模态框统计表 */
  (function fillHelp() {
    var order = ['Project', 'Branch', 'Folder', 'File', 'Module', 'Function', 'Route',
      'Interface', 'Type', 'Enum', 'Section', 'Table', 'EnvVar', 'Method', 'Process', 'Class'];
    var lt = '<tr><th>类型</th><th>说明</th><th style="text-align:right">数量</th></tr>';
    order.forEach(function (lab) {
      var c = META.labelCounts[lab] || 0;
      if (!c) return;
      lt += '<tr><td><span class="swatch" style="background:' + LABEL_COLORS[lab] + '"></span>' + lab + '</td>' +
        '<td>' + (LABEL_CN[lab] || '') + '</td><td class="num">' + fmt(c) + '</td></tr>';
    });
    document.getElementById('help-labels').innerHTML = lt;
    var et = '<tr><th>关系</th><th>说明</th><th style="text-align:right">数量</th></tr>';
    var etDesc = {
      CALLS: '函数 / 方法间的直接调用', DEFINES: '文件 / 模块对其内部实体的定义',
      IMPORTS: '文件 / 模块间的导入依赖', USAGE: '实体对变量 / 常量等的使用',
      CONTAINS_FILE: '目录对文件的包含', CONTAINS_FOLDER: '目录的父子包含',
      HANDLES: '函数对路由的注册处理', HTTP_CALLS: '跨服务 HTTP 接口调用'
    };
    ETYPES.forEach(function (e) {
      var c = META.etypeCounts[e] || 0;
      et += '<tr><td><span class="swatch" style="background:' + ETYPE_COLORS[e] + '"></span>' + e + '</td>' +
        '<td>' + (etDesc[e] || ETYPE_CN[e] || '') + '</td><td class="num">' + fmt(c) + '</td></tr>';
    });
    document.getElementById('help-etypes').innerHTML = et;
  })();

  /* ================= 就绪 ================= */
  setTimeout(function () { document.getElementById('loading').classList.add('done'); }, 400);
})();
