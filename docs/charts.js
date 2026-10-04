/* Route Optimizer Colombo — model charts
 *
 * Renders the performance charts from window.MODEL_METRICS, which is written by
 * ml-pipeline/export_site_metrics.py. Plain SVG, no chart library.
 */
(function () {
  "use strict";

  const M = window.MODEL_METRICS;
  const NS = "http://www.w3.org/2000/svg";
  const C = {
    ink: "#141414", muted: "#67645C", rule: "#D6D0C2", grid: "#E6E1D6",
    signal: "#D9472B", fast: "#2F7A57", mid: "#C9952B", blue: "#3F6A9E", plum: "#7D4E9A",
  };
  const SCEN_COLOURS = {
    weekday: C.ink, weekend: C.fast, long_weekend: C.blue,
    poya: C.mid, avurudu_pre: C.plum, avurudu_post: C.signal,
  };

  function el(name, attrs, parent, text) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  const fmt = (v, d = 1) => Number(v).toFixed(d);
  const pad = (h) => String(h).padStart(2, "0");

  function niceRange(min, max, step) {
    return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
  }

  function frame(host, { w = 720, h = 300, l = 48, r = 16, t = 16, b = 36, label }) {
    host.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, class: "plot", role: "img" }, host);
    if (label) svg.setAttribute("aria-label", label);
    return { svg, w, h, l, r, t, b, iw: w - l - r, ih: h - t - b };
  }

  function yAxis(f, y0, y1, step, unit) {
    const g = el("g", { class: "plot__axis" }, f.svg);
    for (let v = y0; v <= y1 + 1e-9; v += step) {
      const y = f.t + f.ih - ((v - y0) / (y1 - y0)) * f.ih;
      el("line", { x1: f.l, x2: f.l + f.iw, y1: y, y2: y, stroke: C.grid }, g);
      el("text", { x: f.l - 8, y: y + 4, "text-anchor": "end" }, g, fmt(v, step < 1 ? 1 : 0));
    }
    if (unit) el("text", { x: f.l - 8, y: f.t - 4, "text-anchor": "end", class: "plot__unit" }, g, unit);
    return (v) => f.t + f.ih - ((v - y0) / (y1 - y0)) * f.ih;
  }

  function legend(host, items) {
    const ul = document.createElement("ul");
    ul.className = "plot-legend";
    items.forEach((it) => {
      const li = document.createElement("li");
      const sw = document.createElement("i");
      sw.style.background = it.dash ? "none" : it.colour;
      if (it.dash) sw.style.borderTop = `2px dashed ${it.colour}`;
      if (it.dot) { sw.style.borderRadius = "50%"; sw.style.width = "8px"; sw.style.height = "8px"; }
      li.appendChild(sw);
      li.appendChild(document.createTextNode(it.label));
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }

  // ---------- 1. Training curve ----------
  function trainingCurve(host) {
    const log = M.training_log;
    const vals = log.val_mae;
    const floor = M.noise_std * Math.sqrt(2 / Math.PI);
    const f = frame(host, { h: 260, label: `Validation MAE by epoch, from ${fmt(vals[0], 2)} km/h at epoch 1 to a best of ${fmt(Math.min(...vals), 2)} km/h at epoch ${log.best_epoch}; early stopping at epoch ${log.stopped_epoch}.` });
    const [y0, y1] = [0, 5];
    const Y = yAxis(f, y0, y1, 1, "km/h");
    const X = (i) => f.l + 20 + (i / (vals.length - 1)) * (f.iw - 40);
    const ax = el("g", { class: "plot__axis" }, f.svg);
    vals.forEach((_, i) => el("text", { x: X(i), y: f.h - 14, "text-anchor": "middle" }, ax, i + 1));
    el("text", { x: f.l + f.iw, y: f.h - 1, "text-anchor": "end", class: "plot__unit" }, ax, "epoch");

    el("line", { x1: f.l, x2: f.l + f.iw, y1: Y(floor), y2: Y(floor), stroke: C.fast, "stroke-dasharray": "5 4", "stroke-width": 1.5 }, f.svg);
    el("text", { x: f.l + f.iw - 4, y: Y(floor) - 6, "text-anchor": "end", class: "plot__note", fill: C.fast }, f.svg, `noise floor ≈ ${fmt(floor, 2)}`);

    const best = log.best_epoch - 1;
    el("rect", { x: X(log.stopped_epoch - 1 - 3) , y: f.t, width: X(log.stopped_epoch - 1) - X(log.stopped_epoch - 1 - 3), height: f.ih, fill: "#F3EEE4" }, f.svg);
    el("text", { x: X(log.stopped_epoch - 1) - 4, y: f.t + 14, "text-anchor": "end", class: "plot__note" }, f.svg, "patience window (3)");

    el("polyline", { points: vals.map((v, i) => `${X(i)},${Y(v)}`).join(" "), fill: "none", stroke: C.ink, "stroke-width": 2.2 }, f.svg);
    vals.forEach((v, i) => {
      const c = el("circle", { cx: X(i), cy: Y(v), r: i === best ? 6 : 3.5, fill: i === best ? C.signal : C.ink, stroke: "#FBFAF6", "stroke-width": 2 }, f.svg);
      el("title", {}, c, `Epoch ${i + 1}: ${fmt(v, 4)} km/h`);
    });
    el("text", { x: X(best), y: Y(vals[best]) + 22, "text-anchor": "middle", class: "plot__note", fill: C.signal }, f.svg, `best ${fmt(vals[best], 2)}`);
  }

  // ---------- 2. Predicted vs target by hour (scenario tabs) ----------
  function scenarioHours(host, tabsHost) {
    let current = M.scenarios[0].key;
    function draw() {
      const sc = M.scenarios.find((s) => s.key === current);
      const all = sc.hours.flatMap((r) => [r.pred_mean, r.target_mean, r.best_mean]);
      const [y0, y1] = niceRange(Math.min(...all) - 2, Math.max(...all) + 2, 5);
      const f = frame(host, { label: `${sc.label}: network-average predicted speed vs synthetic ground truth for each hour. Mean absolute error ${fmt(sc.mae, 2)} km/h.` });
      const Y = yAxis(f, y0, y1, 5, "km/h");
      const X = (h) => f.l + (h / 23) * f.iw;
      const ax = el("g", { class: "plot__axis" }, f.svg);
      [0, 3, 6, 9, 12, 15, 18, 21, 23].forEach((h) => el("text", { x: X(h), y: f.h - 14, "text-anchor": "middle" }, ax, pad(h)));
      el("text", { x: f.l + f.iw, y: f.h - 1, "text-anchor": "end", class: "plot__unit" }, ax, "hour of day");

      const line = (key, colour, extra) => el("polyline", Object.assign({ points: sc.hours.map((r) => `${X(r.hour)},${Y(r[key])}`).join(" "), fill: "none", stroke: colour, "stroke-width": 2.2 }, extra || {}), f.svg);
      line("best_mean", C.fast, { "stroke-dasharray": "6 4", "stroke-width": 1.8 });
      line("pred_mean", C.signal);
      sc.hours.forEach((r) => {
        const c = el("circle", { cx: X(r.hour), cy: Y(r.target_mean), r: 3, fill: C.ink }, f.svg);
        el("title", {}, c, `${pad(r.hour)}:00 · target ${fmt(r.target_mean)} · predicted ${fmt(r.pred_mean)} · MAE ${fmt(r.mae, 2)} km/h`);
      });
      const out = document.getElementById("scen-mae");
      if (out) out.textContent = `${sc.label} · MAE ${fmt(sc.mae, 2)} km/h across all ${M.graph.nodes.toLocaleString()} intersections`;
    }
    M.scenarios.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.textContent = s.label;
      b.setAttribute("aria-pressed", s.key === current ? "true" : "false");
      b.addEventListener("click", () => {
        current = s.key;
        tabsHost.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-pressed", t === b ? "true" : "false"));
        draw();
      });
      tabsHost.appendChild(b);
    });
    draw();
  }

  // ---------- 3. MAE by scenario vs baselines ----------
  function scenarioBars(host) {
    const series = [
      { key: "mae", label: "ST-GAT", colour: C.signal },
      { key: "mae_persistence", label: "Last observed hour", colour: C.muted },
      { key: "mae_calendar_blind", label: "Typical day, calendar ignored", colour: C.rule },
      { key: "mae_generator_mean", label: "Noise floor (generator mean)", colour: C.fast },
    ];
    const max = Math.max(...M.scenarios.flatMap((s) => series.map((k) => s[k.key])));
    const [, y1] = niceRange(0, max, 2);
    const f = frame(host, { h: 300, b: 52, label: "Mean absolute error for each calendar scenario, comparing ST-GAT with three reference predictors." });
    const Y = yAxis(f, 0, y1, 2, "MAE km/h");
    const groupW = f.iw / M.scenarios.length;
    const barW = Math.min(16, (groupW - 18) / series.length);
    M.scenarios.forEach((s, i) => {
      const gx = f.l + i * groupW + (groupW - barW * series.length) / 2;
      series.forEach((k, j) => {
        const v = s[k.key];
        const r = el("rect", { x: gx + j * barW, y: Y(v), width: barW - 2, height: f.t + f.ih - Y(v), fill: k.colour }, f.svg);
        el("title", {}, r, `${s.label} · ${k.label}: ${fmt(v, 2)} km/h`);
      });
      const lbl = el("text", { x: f.l + i * groupW + groupW / 2, y: f.h - 30, "text-anchor": "middle", class: "plot__axis-label" }, f.svg);
      const words = s.label.split(" ");
      lbl.appendChild(el("tspan", { x: f.l + i * groupW + groupW / 2, dy: 0 }, null, words.slice(0, 2).join(" ")));
      if (words.length > 2) lbl.appendChild(el("tspan", { x: f.l + i * groupW + groupW / 2, dy: 13 }, null, words.slice(2).join(" ")));
    });
    legend(host, series.map((s) => ({ label: s.label, colour: s.colour })));
  }

  // ---------- 4. Deployed inference path ----------
  function deployPath(host) {
    const all = M.deploy_path.flatMap((d) => d.pred_mean);
    const spread = Math.max(...all) - Math.min(...all);
    const step = spread < 2 ? 0.5 : spread < 6 ? 1 : 5;
    const [y0, y1] = niceRange(Math.min(...all) - step, Math.max(...all) + step, step);
    const f = frame(host, { label: "Average predicted speed by hour when only the planning date changes, as in update_osrm_traffic.py." });
    const Y = yAxis(f, y0, y1, step, "km/h");
    const X = (h) => f.l + (h / 23) * f.iw;
    const ax = el("g", { class: "plot__axis" }, f.svg);
    [0, 3, 6, 9, 12, 15, 18, 21, 23].forEach((h) => el("text", { x: X(h), y: f.h - 14, "text-anchor": "middle" }, ax, pad(h)));
    el("text", { x: f.l + f.iw, y: f.h - 1, "text-anchor": "end", class: "plot__unit" }, ax, "departure hour");
    M.deploy_path.forEach((d) => {
      const pl = el("polyline", { points: d.pred_mean.map((v, h) => `${X(h)},${Y(v)}`).join(" "), fill: "none", stroke: SCEN_COLOURS[d.key], "stroke-width": 2 }, f.svg);
      el("title", {}, pl, `${d.label}: ${fmt(Math.min(...d.pred_mean))}–${fmt(Math.max(...d.pred_mean))} km/h`);
    });
    legend(host, M.deploy_path.map((d) => ({ label: d.label, colour: SCEN_COLOURS[d.key] })));
  }

  // ---------- 5. Residual histogram ----------
  function residuals(host) {
    const R = M.residuals;
    const maxC = Math.max(...R.counts);
    const f = frame(host, { h: 240, l: 56, label: `Distribution of prediction errors. Mean ${fmt(R.mean, 2)} km/h, standard deviation ${fmt(R.std, 2)} km/h.` });
    const Y = yAxis(f, 0, maxC, maxC / 4, "");
    const n = R.counts.length;
    const bw = f.iw / n;
    R.counts.forEach((c, i) => {
      const lo = R.bin_edges[i];
      const r = el("rect", { x: f.l + i * bw + 1, y: Y(c), width: bw - 2, height: f.t + f.ih - Y(c), fill: lo < 0 ? C.blue : C.signal, opacity: 0.85 }, f.svg);
      el("title", {}, r, `${lo} to ${lo + 1} km/h: ${c.toLocaleString()} predictions`);
    });
    const ax = el("g", { class: "plot__axis" }, f.svg);
    R.bin_edges.forEach((e, i) => { if (e % 4 === 0) el("text", { x: f.l + i * bw, y: f.h - 14, "text-anchor": "middle" }, ax, e > 0 ? `+${e}` : e); });
    el("text", { x: f.l + f.iw, y: f.h - 1, "text-anchor": "end", class: "plot__unit" }, ax, "predicted − actual, km/h");
    const zx = f.l + (R.bin_edges.indexOf(0)) * bw;
    el("line", { x1: zx, x2: zx, y1: f.t, y2: f.t + f.ih, stroke: C.ink, "stroke-width": 1 }, f.svg);
  }

  // ---------- 6. Earlier model-family benchmark ----------
  function benchmark(host) {
    const rows = M.earlier_benchmark.rows;
    const f = frame(host, { h: 220, l: 170, b: 30, label: "Earlier benchmark of four model families by MAE and RMSE." });
    const max = 5;
    const X = (v) => f.l + (v / max) * f.iw;
    const ax = el("g", { class: "plot__axis" }, f.svg);
    for (let v = 0; v <= max; v++) {
      el("line", { x1: X(v), x2: X(v), y1: f.t, y2: f.t + f.ih, stroke: C.grid }, ax);
      el("text", { x: X(v), y: f.h - 10, "text-anchor": "middle" }, ax, v);
    }
    const rowH = f.ih / rows.length;
    rows.forEach((r, i) => {
      const y = f.t + i * rowH + 6;
      el("text", { x: f.l - 10, y: y + rowH / 2 - 2, "text-anchor": "end", class: "plot__axis-label" }, f.svg, r.model);
      const hiBest = r.model.startsWith("ST-GAT");
      const a = el("rect", { x: f.l, y, width: X(r.rmse) - f.l, height: (rowH - 14) / 2, fill: C.rule }, f.svg);
      el("title", {}, a, `RMSE ${r.rmse}`);
      const b = el("rect", { x: f.l, y: y + (rowH - 14) / 2 + 2, width: X(r.mae) - f.l, height: (rowH - 14) / 2, fill: hiBest ? C.signal : C.ink }, f.svg);
      el("title", {}, b, `MAE ${r.mae}`);
      el("text", { x: X(r.rmse) + 6, y: y + 9, class: "plot__note" }, f.svg, fmt(r.rmse, 2));
      el("text", { x: X(r.mae) + 6, y: y + (rowH - 14) / 2 + 12, class: "plot__note" }, f.svg, fmt(r.mae, 2));
    });
    legend(host, [{ label: "MAE (km/h)", colour: C.ink }, { label: "RMSE (km/h)", colour: C.rule }]);
  }

  // ---------- Parameter table ----------
  function paramTable(host) {
    const B = M.params.blocks;
    const rows = [
      ["gat1", "GATConv 6 → 64, 4 heads (averaged)"],
      ["gat2", "GATConv 64 → 64, 4 heads (averaged)"],
      ["norm1", "LayerNorm 64"],
      ["gru", "GRU, 2 layers, 64 hidden"],
      ["fc1", "Linear 64 → 32"],
      ["fc2", "Linear 32 → 1"],
    ];
    const max = Math.max(...Object.values(B));
    host.innerHTML = rows.map(([k, desc]) => {
      const v = B[k] || 0;
      return `<tr><td><code>${k}</code></td><td>${desc}</td><td class="num">${v.toLocaleString()}</td>` +
        `<td class="bar"><span style="width:${(v / max) * 100}%"></span></td></tr>`;
    }).join("") + `<tr class="total"><td></td><td>Total trainable parameters</td><td class="num">${M.params.total.toLocaleString()}</td><td></td></tr>`;
  }

  function fillText() {
    document.querySelectorAll("[data-metric]").forEach((n) => {
      const path = n.getAttribute("data-metric").split(".");
      let v = M;
      for (const p of path) v = v == null ? v : v[p];
      if (v == null) return;
      const d = n.getAttribute("data-digits");
      n.textContent = typeof v === "number" ? (d != null ? fmt(v, +d) : v.toLocaleString()) : v;
    });
  }

  if (!M) return;
  const q = (id) => document.getElementById(id);
  fillText();
  if (q("chart-training")) trainingCurve(q("chart-training"));
  if (q("chart-scenario")) scenarioHours(q("chart-scenario"), q("scenario-tabs"));
  if (q("chart-scenario-bars")) scenarioBars(q("chart-scenario-bars"));
  if (q("chart-deploy")) deployPath(q("chart-deploy"));
  if (q("chart-residuals")) residuals(q("chart-residuals"));
  if (q("chart-benchmark")) benchmark(q("chart-benchmark"));
  if (q("param-rows")) paramTable(q("param-rows"));
})();
