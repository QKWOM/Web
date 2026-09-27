'use strict';

// 趋势折线图：纯 SVG，不依赖第三方库。
// 几个图表上下排列、共用横轴（年份上下对齐）；鼠标所在（或键盘左右键选中）的年份在所有图表上同时标出，
// 提示框列出这一年的全部数值。
const TrendChart = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const FONT_PX = 12;
  const MARGIN_TOP = 10;
  const MARGIN_BOTTOM = 26; // 横轴年份
  const PAD_X = 10; // 最早、最晚一年离绘图区边缘的距离，圆点不会被截掉
  const DENSE_PX = 14; // 相邻年份间距小于它时只画端点和孤立的点，不给每一年画圆点
  const MAX_GAP = 2; // 相隔超过 2 年的数据之间不连线（两年一届的会议仍然相连）

  let measureCtx = null;
  function textWidth(text) {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = `${FONT_PX}px ${getComputedStyle(document.body).fontFamily}`;
    return Math.ceil(measureCtx.measureText(text).width);
  }

  function svgNode(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.append(node);
    return node;
  }

  function svgText(parent, text, attrs) {
    svgNode('text', attrs, parent).textContent = text;
  }

  function htmlNode(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // 纵轴刻度取 1、2、2.5、5 × 10^k 的整数倍，从 0 开始
  function niceTicks(max, count) {
    if (!(max > 0)) max = 1;
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let i = 0; i * step < max + step - 1e-9; i++) ticks.push(+(i * step).toPrecision(12));
    if (ticks.length < 2) ticks.push(step);
    return ticks;
  }

  // 按数据切分成连续的线段：缺值或相隔太久的年份之间断开
  function segments(rows, key) {
    const out = [];
    let current = [];
    for (const row of rows) {
      const prev = current[current.length - 1];
      if (row[key] == null || (prev && row.year - prev.year > MAX_GAP)) {
        if (current.length) out.push(current);
        current = [];
      }
      if (row[key] != null) current.push(row);
    }
    if (current.length) out.push(current);
    return out;
  }

  function lastDefined(rows, key) {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] != null) return rows[i];
    return null;
  }

  /**
   * 在 root 里画图。model：
   *   rows: [{ year, <key>: 数值或 null, ... }]，按年份升序
   *   charts: [{ title, height, ticks, format(v), tick(v), series: [{ key, label, color }] }]
   *   heading(row): 提示框标题；note(row): 提示框里的备注
   */
  function create(root) {
    let model = null;
    let active = -1;
    let renderedWidth = 0;
    let frames = []; // 每个图表：{ svg, cross, dots, top, plotHeight, y, chart }
    let x = null;

    root.classList.add('trend-chart');
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    const blocks = htmlNode('div', 'trend-blocks');
    const tip = htmlNode('div', 'trend-tip');
    tip.hidden = true;
    tip.setAttribute('role', 'status');
    root.append(blocks, tip);

    function render() {
      const width = root.clientWidth;
      renderedWidth = width;
      blocks.textContent = '';
      frames = [];
      if (!model || !width) return;
      const { rows, charts } = model;
      const minYear = rows[0].year;
      const maxYear = rows[rows.length - 1].year;
      const narrow = width < 480;

      // 所有图表共用左右边距，年份才能上下对齐
      const scales = charts.map((c) => {
        const max = Math.max(0, ...rows.flatMap((r) => c.series.map((s) => r[s.key] ?? 0)));
        return niceTicks(max, narrow ? Math.max(3, c.ticks - 1) : c.ticks);
      });
      const left = 10 + Math.max(...charts.map((c, i) => Math.max(...scales[i].map((t) => textWidth(c.tick(t))))));
      const ends = charts.map((c) => c.series.map((s) => {
        const row = lastDefined(rows, s.key);
        return row && { s, row, text: c.format(row[s.key]) };
      }).filter(Boolean));
      const right = Math.max(12, ...ends.flat().map((e) => textWidth(e.text) + 16));
      const plotWidth = Math.max(40, width - left - right);
      const span = maxYear - minYear;
      const inner = plotWidth - 2 * PAD_X;
      x = (year) => (span ? left + PAD_X + ((year - minYear) / span) * inner : left + plotWidth / 2);
      const pxPerYear = span ? inner / span : Infinity;
      const yearStep = [1, 2, 5, 10, 20, 50].find((s) => s * pxPerYear >= 44) || 100;

      charts.forEach((chart, index) => {
        const ticks = scales[index];
        const top = MARGIN_TOP;
        const plotHeight = Math.round(chart.height * (narrow ? 0.8 : 1));
        const height = top + plotHeight + MARGIN_BOTTOM;
        const maxTick = ticks[ticks.length - 1];
        const y = (v) => top + plotHeight - (v / maxTick) * plotHeight;

        const block = htmlNode('div', 'trend-block');
        const head = htmlNode('div', 'trend-head');
        head.append(htmlNode('h3', 'trend-title', chart.title));
        if (chart.series.length > 1) {
          const legend = htmlNode('div', 'trend-legend');
          for (const s of chart.series) {
            const item = htmlNode('span', 'trend-legend-item');
            const key = htmlNode('span', 'trend-key');
            key.style.setProperty('--c', s.color);
            item.append(key, document.createTextNode(s.label));
            legend.append(item);
          }
          head.append(legend);
        }
        block.append(head);

        const svg = svgNode('svg', {
          class: 'trend-svg', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true',
        });
        // 网格线和纵轴刻度
        for (const t of ticks) {
          const yy = Math.round(y(t)) + 0.5;
          svgNode('line', { class: t === 0 ? 'trend-grid trend-base' : 'trend-grid', x1: left, x2: left + plotWidth, y1: yy, y2: yy }, svg);
          svgText(svg, chart.tick(t), { class: 'trend-tick', x: left - 8, y: yy + 4, 'text-anchor': 'end' });
        }
        // 横轴年份
        for (let yr = Math.ceil(minYear / yearStep) * yearStep; yr <= maxYear; yr += yearStep) {
          svgText(svg, String(yr), { class: 'trend-tick', x: x(yr), y: top + plotHeight + 18, 'text-anchor': 'middle' });
        }
        if (span && yearStep > 1 && minYear % yearStep && x(Math.ceil(minYear / yearStep) * yearStep) - x(minYear) >= 44) {
          svgText(svg, String(minYear), { class: 'trend-tick', x: x(minYear), y: top + plotHeight + 18, 'text-anchor': 'middle' });
        }
        const cross = svgNode('line', { class: 'trend-cross', x1: 0, x2: 0, y1: top, y2: top + plotHeight, visibility: 'hidden' }, svg);

        // 折线和圆点
        for (const s of chart.series) {
          const g = svgNode('g', { class: 'trend-series', style: `--c: ${s.color}` }, svg);
          const last = lastDefined(rows, s.key);
          const segs = segments(rows, s.key);
          for (const seg of segs) {
            if (seg.length < 2) continue;
            const d = seg.map((r, i) => `${i ? 'L' : 'M'}${x(r.year).toFixed(1)},${y(r[s.key]).toFixed(1)}`).join('');
            svgNode('path', { class: 'trend-line', d }, g);
          }
          for (const seg of segs) {
            for (const r of seg) {
              if (pxPerYear >= DENSE_PX || seg.length === 1 || r === last) {
                svgNode('circle', { class: 'trend-dot', cx: x(r.year).toFixed(1), cy: y(r[s.key]).toFixed(1), r: 5 }, g);
              }
            }
          }
        }

        // 末端数值；和已有标签重叠时不标（图例、提示框和数据表里都能看到）
        const placed = [];
        for (const { s, row, text } of ends[index]) {
          const lx = x(row.year) + 10;
          const ly = y(row[s.key]) + 4;
          const box = { x1: lx, x2: lx + textWidth(text), y1: ly - 12, y2: ly + 3 };
          if (placed.some((b) => b.x1 < box.x2 && box.x1 < b.x2 && b.y1 < box.y2 + 2 && box.y1 < b.y2 + 2)) continue;
          placed.push(box);
          svgText(svg, text, { class: 'trend-end', x: lx, y: ly });
        }

        const dots = svgNode('g', { class: 'trend-active' }, svg);
        block.append(svg);
        blocks.append(block);
        frames.push({ svg, cross, dots, y, chart });
      });

      if (active >= 0) setActive(active);
    }

    function nearest(clientX) {
      const rect = frames[0].svg.getBoundingClientRect();
      const px = clientX - rect.left;
      let best = 0;
      model.rows.forEach((r, i) => {
        if (Math.abs(x(r.year) - px) < Math.abs(x(model.rows[best].year) - px)) best = i;
      });
      return best;
    }

    function fillTip(row) {
      tip.textContent = '';
      tip.append(htmlNode('div', 'trend-tip-head', model.heading ? model.heading(row) : String(row.year)));
      for (const chart of model.charts) {
        for (const s of chart.series) {
          const line = htmlNode('div', 'trend-tip-row');
          const key = htmlNode('span', 'trend-key');
          key.style.setProperty('--c', s.color);
          line.append(key, htmlNode('strong', '', row[s.key] == null ? '—' : chart.format(row[s.key])), htmlNode('span', '', s.label));
          tip.append(line);
        }
      }
      const note = model.note ? model.note(row) : '';
      if (note) tip.append(htmlNode('div', 'trend-tip-note', note));
    }

    // 选中某一年；pointerY 是鼠标相对 root 的高度，键盘操作时为空
    function setActive(index, pointerY = null) {
      if (!model || !frames.length) return;
      active = index;
      const row = model.rows[index];
      const cx = x(row.year);
      for (const { cross, dots, y, chart } of frames) {
        cross.setAttribute('x1', cx);
        cross.setAttribute('x2', cx);
        cross.setAttribute('visibility', 'visible');
        dots.textContent = '';
        for (const s of chart.series) {
          if (row[s.key] == null) continue;
          svgNode('circle', { class: 'trend-dot', style: `--c: ${s.color}`, cx, cy: y(row[s.key]), r: 5 }, dots);
        }
      }
      fillTip(row);
      tip.hidden = false;
      const svgLeft = frames[0].svg.getBoundingClientRect().left - root.getBoundingClientRect().left;
      const anchor = svgLeft + cx;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let tx = anchor + 14;
      if (tx + tw > root.clientWidth) tx = anchor - 14 - tw;
      if (tx < 0) tx = Math.max(0, root.clientWidth - tw);
      const ty = Math.min(Math.max(0, (pointerY ?? 40) - th / 2), Math.max(0, root.clientHeight - th));
      tip.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
    }

    function clear() {
      active = -1;
      tip.hidden = true;
      for (const { cross, dots } of frames) {
        cross.setAttribute('visibility', 'hidden');
        dots.textContent = '';
      }
    }

    function onPointer(e) {
      if (!model || !frames.length || !e.target.closest('.trend-svg')) return;
      setActive(nearest(e.clientX), e.clientY - root.getBoundingClientRect().top);
    }
    root.addEventListener('pointermove', onPointer);
    root.addEventListener('pointerdown', onPointer);
    root.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clear(); });
    root.addEventListener('blur', clear);
    root.addEventListener('focus', () => {
      if (model && active < 0 && root.matches(':focus-visible')) setActive(model.rows.length - 1);
    });
    root.addEventListener('keydown', (e) => {
      if (!model) return;
      const last = model.rows.length - 1;
      const from = active < 0 ? last + 1 : active;
      const moves = { ArrowLeft: from - 1, ArrowRight: active < 0 ? last : active + 1, Home: 0, End: last };
      if (e.key === 'Escape') {
        clear();
      } else if (e.key in moves) {
        e.preventDefault();
        setActive(Math.min(last, Math.max(0, moves[e.key])));
      }
    });

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (root.clientWidth !== renderedWidth) render();
      }).observe(root);
    }

    return {
      update(next) {
        model = next && next.rows.length ? next : null;
        active = -1;
        tip.hidden = true;
        render();
      },
    };
  }

  return { create };
})();
